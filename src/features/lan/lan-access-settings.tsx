import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  LanAccessResult,
  LanPeer,
  LanShare,
  LanShareAccess,
  Target,
} from "@serial-workbench/contracts";
import { SettingRow } from "@/components/setting-row";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { copyText } from "@/lib/clipboard";
import { nativeErrorText } from "@/lib/native-error";
import { SETTINGS_ICONS } from "@/lib/settings-icons";
import { hostLanAccess } from "@/lib/tauri";
import { HostContext } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { readLanInvitation } from "./lan-pairing";

type SharedSession = { key: string; label: string; target: Target };
type ShareChoice = LanShareAccess | "none";

function samePeer(left: LanPeer, right: LanPeer) {
  return left.hostId === right.hostId && left.fingerprint === right.fingerprint;
}

function shareKey(target: Target) {
  return JSON.stringify([target.kind, target.id, target.sessionEpoch]);
}

export function LanAccessSettings() {
  const host = useContext(HostContext);
  const connection = host?.connection;
  const hostId = connection?.attachment.hostId;
  const devices = host?.state.devices;
  const sessions = host?.state.sessions;
  const available = useMemo<SharedSession[]>(() => {
    if (!hostId || !sessions || connection?.lanRoute) return [];
    return sessions
      .filter((session) => session.state === "open" && !session.readOnly)
      .map((session) => {
        const target: Target = {
          hostId,
          kind: "session",
          id: session.sessionId,
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
        };
        return {
          target,
          label:
            devices?.find((device) => device.deviceId === session.deviceId)
              ?.systemName ?? session.deviceId,
          key: shareKey(target),
        };
      });
  }, [connection?.lanRoute, devices, hostId, sessions]);
  return (
    <LanAccessRow
      key={connection?.generation}
      generation={connection?.generation}
      sessions={available}
    />
  );
}

function LanAccessRow({
  generation,
  sessions,
}: {
  generation?: string;
  sessions: SharedSession[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<LanAccessResult>();
  const [address, setAddress] = useState("");
  const [peerText, setPeerText] = useState("");
  const [choices, setChoices] = useState<ReadonlyMap<string, ShareChoice>>(
    new Map(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<
    "lanAccess.copied" | "lanAccess.saved"
  >();
  const busy = useRef(false);
  const mounted = useRef(false);
  const nextFocus = useRef<"peer" | "change" | null>(null);
  const peerInput = useRef<HTMLInputElement>(null);
  const changePeer = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const peer = useMemo(() => readLanInvitation(peerText)?.peer, [peerText]);
  const pairing =
    peer && access?.peers.find((item) => samePeer(item.peer, peer));
  const changed = sessions.some(({ key }) => choices.has(key));
  const listening =
    access?.listener.kind === "listening" ? access.listener.address : undefined;
  useEffect(() => {
    if (!open || pending || nextFocus.current === null) return;
    const target = nextFocus.current === "change" ? changePeer : peerInput;
    if (target.current) {
      target.current.focus();
      nextFocus.current = null;
    }
  }, [open, pending, pairing]);

  async function apply(
    work: (instance: string) => Promise<LanAccessResult>,
    saved = false,
  ) {
    if (!generation || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setNotice(undefined);
    try {
      const next = await work(generation);
      if (!mounted.current) return;
      setAccess(next);
      if (saved) {
        setChoices(new Map());
        setNotice("lanAccess.saved");
      }
    } catch (reason) {
      if (mounted.current) setError(reason);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next)
      void apply((instance) => hostLanAccess(instance, { kind: "status" }));
    else {
      setPeerText("");
      setChoices(new Map());
      setNotice(undefined);
      nextFocus.current = null;
    }
  }

  async function copyLocal() {
    if (!access) return;
    setError(null);
    try {
      await copyText(
        JSON.stringify({ ...access.localPeer, address: listening }),
      );
      if (mounted.current) setNotice("lanAccess.copied");
    } catch (reason) {
      if (mounted.current) setError(reason);
    }
  }

  function savePeer() {
    if (!peer) return;
    void apply(async (instance) => {
      const current = await hostLanAccess(instance, { kind: "status" });
      const existing = current.peers.find((item) => samePeer(item.peer, peer));
      const shares = new Map<string, LanShare>(
        existing?.shares.map((share) => [shareKey(share.target), share]),
      );
      for (const { key, target } of sessions) {
        const choice = choices.get(key);
        if (choice === "none") shares.delete(key);
        else if (choice) shares.set(key, { target, access: choice });
      }
      if (existing && !changed) return current;
      const next = await hostLanAccess(instance, {
        kind: "setShares",
        peer,
        shares: [...shares.values()],
      });
      if (mounted.current) nextFocus.current = "change";
      return next;
    }, true);
  }

  function clearPeer() {
    nextFocus.current = "peer";
    setPeerText("");
    setChoices(new Map());
    setNotice(undefined);
  }

  function unpairPeer() {
    if (!pairing) return;
    void apply(async (instance) => {
      const next = await hostLanAccess(instance, {
        kind: "unpair",
        peer: pairing.peer,
      });
      if (mounted.current) clearPeer();
      return next;
    }, true);
  }

  return (
    <SettingRow
      id="settings-lan-access"
      icon={SETTINGS_ICONS.lanAccess}
      label={t("lanAccess.title")}
    >
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" disabled={!generation}>
            {t("lanAccess.manage")}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("lanAccess.title")}</DialogTitle>
            <DialogDescription>{t("lanAccess.description")}</DialogDescription>
          </DialogHeader>
          {!access && pending && <p role="status">{t("lanAccess.loading")}</p>}
          {!access && !pending && error !== null && (
            <Button
              variant="outline"
              onClick={() =>
                void apply((instance) =>
                  hostLanAccess(instance, { kind: "status" }),
                )
              }
            >
              {t("lanAccess.retry")}
            </Button>
          )}
          {access && (
            <>
              <div className="grid gap-2">
                {listening ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {t("lanAccess.listening", { address: listening })}
                    </span>
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void apply((instance) =>
                          hostLanAccess(instance, { kind: "disable" }),
                        )
                      }
                    >
                      {t("lanAccess.stop")}
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <Label htmlFor="lan-listen-address">
                      {t("lanAccess.address")}
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        id="lan-listen-address"
                        className="min-w-40 flex-1"
                        placeholder="192.168.1.8:8022"
                        value={address}
                        onChange={(event) => setAddress(event.target.value)}
                        disabled={pending}
                      />
                      <Button
                        disabled={pending || !address.trim()}
                        onClick={() =>
                          void apply((instance) =>
                            hostLanAccess(instance, {
                              kind: "enable",
                              address: address.trim(),
                            }),
                          )
                        }
                      >
                        {t("lanAccess.start")}
                      </Button>
                    </div>
                  </div>
                )}
                <Button
                  className="justify-self-start"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void copyLocal()}
                >
                  {t("lanAccess.copy")}
                </Button>
              </div>
              <div className="grid gap-2 border-t pt-4">
                {pairing ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">{t("lanAccess.paired")}</span>
                    <Button
                      ref={changePeer}
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={clearPeer}
                    >
                      {t("lanAccess.changePeer")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <Label htmlFor="lan-peer-info">{t("lanAccess.peer")}</Label>
                    <Input
                      ref={peerInput}
                      id="lan-peer-info"
                      type="password"
                      autoComplete="off"
                      maxLength={768}
                      value={peerText}
                      disabled={pending}
                      onChange={(event) => {
                        const value = event.target.value;
                        const entered = readLanInvitation(value)?.peer;
                        if (
                          entered &&
                          access.peers.some(({ peer }) =>
                            samePeer(peer, entered),
                          )
                        )
                          nextFocus.current = "change";
                        setPeerText(value);
                        setChoices(new Map());
                        setNotice(undefined);
                      }}
                    />
                    {peerText && !peer && (
                      <p className="text-sm text-muted-foreground">
                        {t("lanAccess.invalidPeer")}
                      </p>
                    )}
                  </>
                )}
                {peer && (
                  <>
                    {!pairing && (
                      <p className="text-sm text-muted-foreground">
                        {t("lanAccess.pairInstruction")}
                      </p>
                    )}
                    {sessions.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        {t("lanAccess.noOpenSession")}
                      </p>
                    )}
                    {sessions.map(({ key, label }, i) => (
                      <div
                        key={key}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <Label htmlFor={`lan-session-${i}`}>{label}</Label>
                        <Select
                          value={
                            choices.get(key) ??
                            pairing?.shares.find(
                              (share) => shareKey(share.target) === key,
                            )?.access ??
                            "none"
                          }
                          disabled={pending}
                          onValueChange={(choice) => {
                            if (
                              choice === "none" ||
                              choice === "readOnly" ||
                              choice === "operate"
                            )
                              setChoices((before) =>
                                new Map(before).set(key, choice),
                              );
                          }}
                        >
                          <SelectTrigger id={`lan-session-${i}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">
                              {t("lanAccess.none")}
                            </SelectItem>
                            <SelectItem value="readOnly">
                              {t("lanAccess.readOnly")}
                            </SelectItem>
                            <SelectItem value="operate">
                              {t("lanAccess.operate")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-2">
                      {(!pairing || changed) && (
                        <Button disabled={pending} onClick={savePeer}>
                          {t(pairing ? "lanAccess.save" : "lanAccess.pair")}
                        </Button>
                      )}
                      {pairing && (
                        <Button
                          variant="outline"
                          disabled={pending}
                          onClick={unpairPeer}
                        >
                          {t("lanAccess.unpair")}
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
          {notice && (
            <p role="status" className="text-sm">
              {t(notice)}
            </p>
          )}
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {nativeErrorText(error, t)}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </SettingRow>
  );
}
