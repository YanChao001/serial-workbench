//! fork 后的可信原生监护是 Node 的直接父进程；不依赖尚未验签的 JS。
mod process_identity;
use super::{Control, NodeRuntimeProbeDiagnostics, failure, macos_image::SuspendedExec};
use serial_workbench_core::HostResult;
use std::{
    fs::File,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::process::{CommandExt, ExitStatusExt},
    },
    process::{Command, ExitStatus},
    thread,
    time::Duration,
};

pub(super) struct Prepared {
    control: File,
    replies: File,
}
pub(super) struct Node {
    control: Option<File>,
    replies: File,
    received: usize,
    bytes: [u8; 16],
    messages: u8,
    node_id: Option<u32>,
    observer: Option<(u32, u64)>,
    raw_status: Option<i32>,
    launch_error: Option<i32>,
}
impl Prepared {
    pub(super) fn configure(command: &mut Command, exec: SuspendedExec) -> io::Result<Self> {
        let (commands, control) = pipe()?;
        let (replies, output) = pipe()?;
        let parent_control = control.as_raw_fd();
        let parent_replies = replies.as_raw_fd();
        let parent_pid = unsafe { libc::getpid() };
        // Host 不修改 RLIMIT_NOFILE。覆盖继承的超限 fd 和 spawn 期间新建的 fd。
        let mut max_fd = unsafe { libc::getdtablesize() };
        if max_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        for entry in std::fs::read_dir("/dev/fd")? {
            if let Ok(fd) = entry?.file_name().to_string_lossy().parse::<libc::c_int>() {
                max_fd = max_fd.max(fd.saturating_add(1));
            }
        }
        command.process_group(0);
        #[cfg(test)]
        let before_fork = super::child::before_fork_descriptor();
        #[cfg(test)]
        let before_exec = super::child::before_exec_descriptors();
        #[cfg(test)]
        let before_observer = super::child::before_observer_descriptor();
        // 所有分配、CString、fd 与属性在fork前准备；原生监护、观察者及Node分支只用栈和原生调用。
        unsafe {
            command.pre_exec(move || {
                libc::close(parent_control);
                libc::close(parent_replies);
                reset_signals()?;
                let group = libc::getpid();
                #[cfg(test)]
                if let Some(fd) = before_fork {
                    send(fd, &(group as u32).to_ne_bytes());
                    loop {
                        libc::poll(std::ptr::null_mut(), 0, 1000);
                    }
                }
                // 观察进程先建立独立组；监护随后迁入，二者都不属于Host组。
                let observer = libc::fork();
                if observer < 0 {
                    return Err(io::Error::last_os_error());
                }
                if observer == 0 {
                    #[cfg(test)]
                    if let Some(fd) = before_observer {
                        send(fd, &(group as u32).to_ne_bytes());
                        send(fd, &(libc::getpid() as u32).to_ne_bytes());
                        loop {
                            libc::poll(std::ptr::null_mut(), 0, 1000);
                        }
                    }
                    if ignore_control_signals() != 0 || libc::dup2(output.as_raw_fd(), 1) < 0 {
                        libc::_exit(125);
                    }
                    observe(group, max_fd)
                }
                // 只有B发布身份后才自行建组。A不能替尚未发布身份的B提前建组。
                while libc::getpgid(observer) != observer {
                    let mut info: libc::siginfo_t = std::mem::zeroed();
                    let ready = libc::waitid(
                        libc::P_PID,
                        observer as libc::id_t,
                        &mut info,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    );
                    if ready < 0 && *libc::__error() == libc::EINTR {
                        continue;
                    }
                    if ready != 0 || info.si_pid == observer || libc::getppid() != parent_pid {
                        finish(0, observer, false);
                    }
                    libc::poll(std::ptr::null_mut(), 0, 1);
                }
                let node = libc::fork();
                if node < 0 {
                    finish(0, observer, false);
                }
                if node == 0 {
                    // Node保留监护PID命名的组。等监护离组后才执行，避免移动组触发暂停映像恢复。
                    loop {
                        if libc::getppid() != group {
                            libc::_exit(126);
                        }
                        let actual = libc::getpgid(group);
                        if actual < 0 {
                            libc::_exit(126);
                        }
                        if actual != group {
                            break;
                        }
                        libc::poll(std::ptr::null_mut(), 0, 1);
                    }
                    #[cfg(test)]
                    if let Some((marker, release)) = before_exec {
                        send(marker, &(libc::getpid() as u32).to_ne_bytes());
                        send(marker, &(group as u32).to_ne_bytes());
                        send(marker, &(observer as u32).to_ne_bytes());
                        let mut byte = 0u8;
                        while libc::pread(release, (&mut byte as *mut u8).cast(), 1, 0) != 1 {
                            libc::poll(std::ptr::null_mut(), 0, 1);
                        }
                    }
                    let result = exec.replace(group);
                    let code = result
                        .as_ref()
                        .err()
                        .and_then(io::Error::raw_os_error)
                        .unwrap_or(libc::EIO);
                    send_record(output.as_raw_fd(), 4, code as u32, 0);
                    // 不回到Rust的exec-error trampoline；它会提前wait直接监护并丢失组锚。
                    // 原生监护收取Node真实终态后，Host再从普通Child路径持有/收取监护。
                    libc::_exit(if result.is_err() { 126 } else { 125 });
                }
                if ignore_control_signals() != 0 {
                    finish(node, observer, false);
                }
                // Node保留自己的stdio；监护只保留独立Host通道。
                if libc::dup2(commands.as_raw_fd(), 0) < 0 || libc::dup2(output.as_raw_fd(), 1) < 0
                {
                    finish(node, observer, false);
                }
                for fd in 2..max_fd {
                    libc::close(fd);
                }
                if !send_record(1, 2, node as u32, 0) || libc::setpgid(0, observer) != 0 {
                    finish(node, observer, false);
                }
                supervise(parent_pid, node, observer)
            });
        }
        let flags = unsafe { libc::fcntl(replies.as_raw_fd(), libc::F_GETFL) };
        if flags < 0
            || unsafe { libc::fcntl(replies.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) }
                < 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { control, replies })
    }
    pub(super) fn into_node(self) -> Node {
        Node {
            control: Some(self.control),
            replies: self.replies,
            received: 0,
            bytes: [0; 16],
            messages: 0,
            node_id: None,
            observer: None,
            raw_status: None,
            launch_error: None,
        }
    }
}
impl Node {
    pub(super) fn initialize(
        &mut self,
        control: &Control<'_>,
        diagnostics: &mut NodeRuntimeProbeDiagnostics,
    ) -> HostResult<()> {
        while self.node_id.is_none() || self.observer.is_none() {
            control.check()?;
            if !self
                .read()
                .map_err(|_| failure("NODE_RUNTIME_START_FAILED", "supervisorHandshake"))?
            {
                thread::sleep(Duration::from_millis(5));
            }
        }
        // Node先写exec errno再_exit关闭Rust的CLOEXEC屏障；spawn已返回时错误帧必已在管道中。
        // 暂停成功的Node尚不能运行，因此此处无需等待用户代码或猜测时序。
        loop {
            match self.read() {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(_) => return Err(failure("NODE_RUNTIME_START_FAILED", "supervisorHandshake")),
            }
        }
        if let Some(code) = self.launch_error {
            diagnostics.launch_errno = Some(code);
            diagnostics.io_error = Some(io::Error::from_raw_os_error(code).to_string());
            eprintln!("node_runtime_launch_failed os_error={code}");
            return Err(failure("NODE_RUNTIME_START_FAILED", "processLaunch"));
        }
        if self.id() == 0
            || self.id() > i32::MAX as u32
            || self.observer_id() <= 1
            || self.observer_id() > i32::MAX as u32
            || self.observer.is_none_or(|(_, unique)| unique == 0)
        {
            return Err(failure("NODE_RUNTIME_START_FAILED", "supervisorIdentity"));
        }
        Ok(())
    }
    pub(super) fn id(&self) -> u32 {
        self.node_id.unwrap_or(0)
    }
    pub(super) fn observer_id(&self) -> u32 {
        self.observer.map_or(0, |(pid, _)| pid)
    }
    pub(super) fn wait_observer(&mut self) -> io::Result<()> {
        while self.observer.is_none() {
            match self.read() {
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
                Err(error) => return Err(error),
                Ok(false) => thread::sleep(Duration::from_millis(5)),
                Ok(true) => {}
            }
        }
        let (pid, unique) = self.observer.expect("native observer identity received");
        if pid <= 1 || pid > i32::MAX as u32 || unique == 0 {
            return Err(io::Error::from_raw_os_error(libc::EIO));
        }
        while process_identity::read(pid)? == Some(unique) {
            thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
    fn read(&mut self) -> io::Result<bool> {
        loop {
            match self.replies.read(&mut self.bytes[self.received..]) {
                Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
                Ok(count) => {
                    self.received += count;
                    if self.received == self.bytes.len() {
                        self.received = 0;
                        self.messages += 1;
                        if self.messages > 4 {
                            return Err(io::ErrorKind::InvalidData.into());
                        }
                        let tag = u32::from_ne_bytes(
                            self.bytes[..4].try_into().expect("fixed record tag"),
                        );
                        let value = u32::from_ne_bytes(
                            self.bytes[4..8].try_into().expect("fixed record value"),
                        );
                        let identity = u64::from_ne_bytes(
                            self.bytes[8..].try_into().expect("fixed record identity"),
                        );
                        let duplicate = match tag {
                            1 => self.observer.replace((value, identity)).is_some(),
                            2 => self.node_id.replace(value).is_some(),
                            3 => self.raw_status.replace(value as i32).is_some(),
                            4 => self.launch_error.replace(value as i32).is_some(),
                            _ => true,
                        };
                        if duplicate {
                            return Err(io::ErrorKind::InvalidData.into());
                        }
                    }
                    return Ok(true);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    return Ok(false);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
    }
    pub(super) fn resume(&mut self) -> io::Result<()> {
        self.control
            .as_mut()
            .ok_or(io::ErrorKind::BrokenPipe)?
            .write_all(b"R")
    }
    pub(super) fn stop(&mut self) -> io::Result<()> {
        if let Some(mut control) = self.control.take() {
            // 显式停止不依赖其他继承者关闭 fd；父死亡另由实时 PPID 观察兜底。
            let _ = control.write_all(b"S");
        }
        Ok(())
    }
    pub(super) fn exit_status(&mut self, supervisor: ExitStatus) -> io::Result<ExitStatus> {
        self.control.take();
        while self.raw_status.is_none() {
            if !self.read()? {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
        }
        if !supervisor.success() {
            return Err(io::Error::other("Native Node supervision failed"));
        }
        Ok(ExitStatus::from_raw(
            self.raw_status.expect("native raw exit status received"),
        ))
    }
}

pub(super) fn validate_parent_wait_policy() -> HostResult<()> {
    // 自动回收会使未wait的直接子PID失去锚定责任；只拒绝，不修改Host全局信号策略。
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    if unsafe { libc::sigaction(libc::SIGCHLD, std::ptr::null(), &mut action) } != 0
        || action.sa_sigaction == libc::SIG_IGN
        || action.sa_flags & libc::SA_NOCLDWAIT != 0
    {
        return Err(failure(
            "NODE_RUNTIME_START_FAILED",
            "parentChildWaitPolicy",
        ));
    }
    Ok(())
}

pub(super) fn owner_exited(pid: u32) -> io::Result<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(info.si_pid != 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}
pub(super) fn stop_group(pid: u32) -> io::Result<()> {
    let group = pid as libc::pid_t;
    if unsafe { libc::kill(-group, libc::SIGKILL) } != 0 {
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => {}
            // Darwin 的 POSIX kill 会跳过 zombie，组存在但没有可投递成员时返回 EPERM。
            // 只继续回收已无活动成员的组，真正的权限错误仍返回给调用方。
            Some(libc::EPERM) if !group_has_live_members(group)? => {}
            _ => return Err(error),
        }
    }
    // 若监护仅被暂停，恢复它完成对子进程的wait。仍由Host持有其未reap身份。
    let _ = unsafe { libc::kill(group, libc::SIGCONT) };
    Ok(())
}
fn group_has_live_members(group: libc::pid_t) -> io::Result<bool> {
    let mut members = vec![0; 8];
    loop {
        let count = read_group(group, &mut members)?;
        for &pid in &members[..count] {
            // getpgid 只查询活动 PID。数字 PID 已被其他组复用时也不能算作本组成员。
            let actual = unsafe { libc::getpgid(pid) };
            if actual == group {
                return Ok(true);
            }
            if actual < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
            }
        }
        if count < members.len() {
            return Ok(false);
        }
        members.resize(members.len() * 2, 0);
    }
}
fn read_group(group: libc::pid_t, members: &mut [libc::pid_t]) -> io::Result<usize> {
    let size = libc::c_int::try_from(std::mem::size_of_val(members))
        .map_err(|_| io::Error::from_raw_os_error(libc::EOVERFLOW))?;
    let count = unsafe { libc::proc_listpgrppids(group, members.as_mut_ptr().cast(), size) };
    usize::try_from(count).map_err(|_| io::Error::last_os_error())
}
pub(super) fn wait_group_gone(pid: u32) -> io::Result<()> {
    let group = pid as libc::pid_t;
    loop {
        // libproc也枚举zombie。监护可能尚未离组；只允许该未reap锚自身留在组中。
        // 两个槽能区分唯一锚与锚之外的成员，避免早期监护死亡时等待自己的zombie。
        let mut members = [0; 2];
        let count = read_group(group, &mut members)?;
        if count == 0 || (count == 1 && members[0] == group) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn pipe() -> io::Result<(File, File)> {
    fn owned(fd: OwnedFd) -> io::Result<File> {
        if fd.as_raw_fd() >= 3 {
            return Ok(fd.into());
        }
        let duplicate = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
        if duplicate < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(File::from(unsafe { OwnedFd::from_raw_fd(duplicate) }))
    }
    let (reader, writer) = io::pipe()?;
    Ok((owned(reader.into())?, owned(writer.into())?))
}

// 以下只在 fork 子进程执行：不分配、不取锁、不记录日志，不运行 Rust 清理器。
unsafe fn reset_signals() -> io::Result<()> {
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
    }
    for signal in 1..=libc::SIGUSR2 {
        if signal == libc::SIGKILL || signal == libc::SIGSTOP {
            continue;
        }
        action.sa_sigaction = if signal == libc::SIGPIPE {
            libc::SIG_IGN
        } else {
            libc::SIG_DFL
        };
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    if unsafe { libc::sigprocmask(libc::SIG_SETMASK, &action.sa_mask, std::ptr::null_mut()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
unsafe fn ignore_control_signals() -> libc::c_int {
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
    }
    action.sa_sigaction = libc::SIG_IGN;
    for signal in [libc::SIGHUP, libc::SIGINT, libc::SIGTERM, libc::SIGQUIT] {
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
            return -1;
        }
    }
    0
}
unsafe fn send(fd: RawFd, mut bytes: &[u8]) -> bool {
    while !bytes.is_empty() {
        let count = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if count > 0 {
            bytes = &bytes[count as usize..];
        } else if count < 0 && unsafe { *libc::__error() } == libc::EINTR {
            continue;
        } else {
            return false;
        }
    }
    true
}
unsafe fn send_record(fd: RawFd, tag: u32, value: u32, identity: u64) -> bool {
    // 最多四条独立的定长记录均小于PIPE_BUF，Node/监护/观察者的消息不会交错。
    let mut record = [0u8; 16];
    record[..4].copy_from_slice(&tag.to_ne_bytes());
    record[4..8].copy_from_slice(&value.to_ne_bytes());
    record[8..].copy_from_slice(&identity.to_ne_bytes());
    unsafe { send(fd, &record) }
}
unsafe fn reap(pid: libc::pid_t) -> Option<libc::c_int> {
    if pid <= 0 {
        return None;
    }
    let mut status = 0;
    loop {
        let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
        if waited == pid {
            return Some(status);
        }
        if waited < 0 && unsafe { *libc::__error() } == libc::EINTR {
            continue;
        }
        return None;
    }
}
unsafe fn finish(node: libc::pid_t, observer: libc::pid_t, report: bool) -> ! {
    // 组名仍是未reap监护PID。离组前Node尚不能exec，此时只能杀直接Node而不能杀自己。
    if node > 0 {
        unsafe {
            if libc::getpgrp() != libc::getpid() {
                libc::kill(-libc::getpid(), libc::SIGKILL);
            }
            libc::kill(node, libc::SIGKILL);
        }
    }
    let status = unsafe { reap(node) };
    unsafe {
        libc::kill(observer, libc::SIGKILL);
    }
    let observer_status = unsafe { reap(observer) };
    if report
        && observer_status.is_some()
        && let Some(status) = status
    {
        unsafe {
            send_record(1, 3, status as u32, 0);
        }
    }
    unsafe {
        libc::_exit(if report && status.is_some() && observer_status.is_some() {
            0
        } else {
            125
        });
    }
}
unsafe fn observe(parent: libc::pid_t, max_fd: libc::c_int) -> ! {
    let pid = unsafe { libc::getpid() };
    let identity = match process_identity::read(pid as u32) {
        Ok(Some(identity)) => identity,
        _ => unsafe { libc::_exit(125) },
    };
    // 先公布唯一身份再关闭继承的Rust exec-error管道。spawn返回后若观察者仍活着，Host必能读到身份。
    if !unsafe { send_record(1, 1, pid as u32, identity) } {
        unsafe {
            libc::kill(-parent, libc::SIGKILL);
            libc::_exit(125);
        }
    }
    // 未公布身份时始终留在监护原组，Host可完整枚举回收；发布后才允许两者迁入私有组。
    if unsafe { libc::setpgid(0, 0) } != 0 {
        unsafe {
            libc::_exit(125);
        }
    }
    unsafe {
        libc::close(0);
    }
    for fd in 2..max_fd {
        unsafe {
            libc::close(fd);
        }
    }
    loop {
        if unsafe { libc::getppid() } != parent {
            // Host活着时仍持有parent这个直接子PID锚；Node忙线程不会阻止原生回收。
            unsafe {
                libc::kill(-parent, libc::SIGKILL);
                libc::_exit(0);
            }
        }
        unsafe {
            libc::poll(std::ptr::null_mut(), 0, 50);
        }
    }
}
unsafe fn supervise(parent: libc::pid_t, node: libc::pid_t, observer: libc::pid_t) -> ! {
    let mut resumed = false;
    loop {
        if unsafe { libc::getppid() } != parent {
            unsafe {
                finish(node, observer, true);
            }
        }
        let mut observer_info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let observer_wait = unsafe {
            libc::waitid(
                libc::P_PID,
                observer as libc::id_t,
                &mut observer_info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if observer_wait < 0 && unsafe { *libc::__error() } == libc::EINTR {
            continue;
        }
        if observer_wait != 0 || observer_info.si_pid == observer {
            unsafe {
                finish(node, observer, false);
            }
        }
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                node as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            if unsafe { *libc::__error() } == libc::EINTR {
                continue;
            }
            unsafe {
                finish(node, observer, false);
            }
        }
        if info.si_pid == node {
            unsafe {
                finish(node, observer, true);
            }
        }
        let mut input = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut input, 1, 50) };
        if ready < 0 {
            if unsafe { *libc::__error() } == libc::EINTR {
                continue;
            }
            unsafe {
                finish(node, observer, false);
            }
        }
        if ready == 0 {
            continue;
        }
        let mut command = [0u8; 1];
        if unsafe { libc::read(0, command.as_mut_ptr().cast(), 1) } != 1 {
            unsafe {
                finish(node, observer, true);
            }
        }
        if command[0] == b'R' && !resumed && unsafe { libc::getppid() } == parent {
            if unsafe { libc::kill(node, libc::SIGCONT) } != 0 {
                unsafe {
                    finish(node, observer, false);
                }
            }
            resumed = true;
        } else {
            unsafe {
                finish(node, observer, true);
            }
        }
    }
}
