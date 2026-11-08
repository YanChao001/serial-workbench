use std::{collections::BTreeMap, ffi::OsString, path::PathBuf};

#[derive(Debug, PartialEq)]
struct Options {
    profile: PathBuf,
    duration_seconds: u64,
    result: PathBuf,
    log_dir: PathBuf,
}

fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Options, String> {
    let mut values = BTreeMap::new();
    let mut args = args.into_iter();
    while let Some(key) = args.next() {
        let key = key
            .into_string()
            .map_err(|_| "Option names must be UTF-8")?;
        if !["--profile", "--duration-seconds", "--result", "--log-dir"].contains(&key.as_str()) {
            return Err(format!("Unknown option {key}"));
        }
        let value = args
            .next()
            .ok_or_else(|| format!("{key} requires a value"))?;
        if value.is_empty() || value.to_str().is_some_and(|value| value.starts_with("--")) {
            return Err(format!("{key} requires a value"));
        }
        if values.insert(key.clone(), value).is_some() {
            return Err(format!("Duplicate option {key}"));
        }
    }
    let mut take = |name: &str| values.remove(name).ok_or_else(|| format!("Missing {name}"));
    let profile = take("--profile")?.into();
    let duration = take("--duration-seconds")?;
    if duration != "600" {
        return Err("M1 T06 requires exactly --duration-seconds 600".into());
    }
    Ok(Options {
        profile,
        duration_seconds: 600,
        result: take("--result")?.into(),
        log_dir: take("--log-dir")?.into(),
    })
}

pub(super) async fn run(args: impl IntoIterator<Item = OsString>) -> Result<(), String> {
    let args: Vec<_> = args.into_iter().collect();
    if args.first().is_some_and(|arg| arg == "--owned-fault-host") {
        if args.len() != 5 || args[1] != "--profile" || args[3] != "--log-dir" {
            return Err("Invalid owned Host arguments".into());
        }
        return super::runner::owned_host(PathBuf::from(&args[2]), PathBuf::from(&args[4])).await;
    }
    if args
        .first()
        .is_some_and(|arg| arg == "--owned-crash-writer")
    {
        if args.len() != 4 || args[2] != "--ready" {
            return Err("Invalid crash writer arguments".into());
        }
        return super::disk::crash_writer(PathBuf::from(&args[1]), PathBuf::from(&args[3])).await;
    }
    let options = parse(args)?;
    // Keep the full scenario state off the entry/main future's inline stack path.
    Box::pin(super::runner::run(
        options.profile,
        options.duration_seconds,
        options.result,
        options.log_dir,
    ))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<OsString> {
        words.iter().map(OsString::from).collect()
    }

    #[test]
    fn accepts_exact_wrapper_arguments() {
        let expected = Options {
            profile: PathBuf::from("/profile"),
            duration_seconds: 600,
            result: PathBuf::from("/evidence/result.json"),
            log_dir: PathBuf::from("/evidence"),
        };
        assert_eq!(
            parse(args(&[
                "--profile",
                "/profile",
                "--duration-seconds",
                "600",
                "--result",
                "/evidence/result.json",
                "--log-dir",
                "/evidence"
            ])),
            Ok(expected)
        );
    }

    #[test]
    fn rejects_missing_duplicate_unknown_or_shortened_run() {
        for invalid in [
            args(&[]),
            args(&["--profile", "/p"]),
            args(&["--profile", "/p", "--profile", "/p"]),
            args(&["--unknown", "true"]),
            args(&[
                "--profile",
                "/p",
                "--duration-seconds",
                "1",
                "--result",
                "/r",
                "--log-dir",
                "/l",
            ]),
        ] {
            assert!(parse(invalid).is_err());
        }
    }

    #[tokio::test]
    async fn unexecuted_scenarios_can_never_pass() {
        assert!(
            run(args(&[
                "--profile",
                "/p",
                "--duration-seconds",
                "600",
                "--result",
                "/r",
                "--log-dir",
                "/l"
            ]))
            .await
            .is_err()
        );
    }
}
