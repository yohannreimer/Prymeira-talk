import { Bell, BellOff, BellRing } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useOptionalTalkSession } from '../../app/session/TalkSessionProvider';
import { describeAlert, titleWithCount } from './alert-rules';
import { playAlertSound, unlockAlertSound } from './alert-sound';

const SOUND_OFF_KEY = 'talk-alerts-sound-off';
const POPUPS_OFF_KEY = 'talk-alerts-popups-off';
const ASKED_KEY = 'talk-alerts-permission-asked';
const SOUND_GAP_MS = 2_500;

function readFlag(key: string) {
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}
function writeFlag(key: string, value: boolean) {
  try { localStorage.setItem(key, String(value)); } catch { /* private mode: the choice lasts this tab */ }
}
function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}
function personIsHere() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

type TalkAlertsProps = { activeModule: string; onOpenConversation: (conversationId: string) => void };

/** Sound, browser notification and a count in the tab title for customers waiting on the team. */
export function TalkAlerts(props: TalkAlertsProps) {
  const context = useOptionalTalkSession();
  if (!context) return null;
  return <TalkAlertsConnected {...props} />;
}

function TalkAlertsConnected({ activeModule, onOpenConversation }: TalkAlertsProps) {
  const { session } = useOptionalTalkSession()!;
  const [soundOff, setSoundOff] = useState(() => readFlag(SOUND_OFF_KEY));
  const [popupsOff, setPopupsOff] = useState(() => readFlag(POPUPS_OFF_KEY));
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState(notificationPermission);
  const panel = useRef<HTMLDivElement>(null);
  const live = useRef({ activeModule, soundOff, popupsOff, onOpenConversation });
  live.current = { activeModule, soundOff, popupsOff, onOpenConversation };
  const waiting = useRef(new Set<string>());
  const baseTitle = useRef(document.title);
  const lastSound = useRef(0);

  useEffect(() => {
    const updateTitle = () => { document.title = titleWithCount(baseTitle.current, waiting.current.size); };
    const back = () => {
      if (!personIsHere() || waiting.current.size === 0) return;
      waiting.current.clear(); updateTitle();
    };
    const firstTouch = () => {
      unlockAlertSound();
      if (notificationPermission() === 'default' && !readFlag(ASKED_KEY)) {
        writeFlag(ASKED_KEY, true);
        void Notification.requestPermission().then(setPermission).catch(() => {});
      }
    };
    const unsubscribe = session.subscribeAlerts(alert => {
      const notice = describeAlert(alert);
      if (!notice) return;
      const here = personIsHere();
      const looking = here && live.current.activeModule === 'atendimento' &&
        session.readUI<string | null>('selectedConversation', null) === notice.conversationId;
      if (looking) return;
      const now = Date.now();
      if (!live.current.soundOff && (now - lastSound.current > SOUND_GAP_MS || alert.kind === 'handoff')) {
        lastSound.current = now; playAlertSound(alert.kind);
      }
      if (here) return;
      waiting.current.add(notice.conversationId); updateTitle();
      if (live.current.popupsOff || notificationPermission() !== 'granted') return;
      try {
        const notification = new Notification(notice.title, { body: notice.body, tag: notice.conversationId });
        notification.onclick = () => {
          window.focus(); live.current.onOpenConversation(notice.conversationId); notification.close();
        };
      } catch { /* some mobile browsers only notify from a service worker */ }
    });
    window.addEventListener('focus', back); document.addEventListener('visibilitychange', back);
    window.addEventListener('pointerdown', firstTouch); window.addEventListener('keydown', firstTouch);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back);
      window.removeEventListener('pointerdown', firstTouch); window.removeEventListener('keydown', firstTouch);
      document.title = baseTitle.current;
    };
  }, [session]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [open]);

  function toggleSound() {
    const next = !soundOff; setSoundOff(next); writeFlag(SOUND_OFF_KEY, next);
    if (!next) unlockAlertSound();
  }
  function togglePopups() {
    const next = !popupsOff; setPopupsOff(next); writeFlag(POPUPS_OFF_KEY, next);
    if (!next && notificationPermission() === 'default') {
      void Notification.requestPermission().then(setPermission).catch(() => {});
    }
  }

  const allOff = soundOff && popupsOff;
  const Icon = allOff ? BellOff : soundOff ? Bell : BellRing;
  const summary = allOff ? 'Avisos desligados' : soundOff ? 'Avisos sem som' : 'Avisos ligados';
  return <div className="rail-alerts-wrap" ref={panel}>
    <button type="button" className={`rail-button rail-alerts${allOff ? ' is-muted' : ''}`} onClick={() => setOpen(value => !value)}
      aria-label={summary} aria-expanded={open} aria-haspopup="dialog" title={summary}>
      <Icon size={20} aria-hidden="true" />
      <span className="rail-label">{summary}</span>
    </button>
    {open ? <div className="alerts-panel" role="dialog" aria-label="Avisos de mensagem nova">
      <strong>Avisos de mensagem nova</strong>
      <label className="alerts-switch">
        <input type="checkbox" checked={!soundOff} onChange={toggleSound} />
        <span>Tocar som</span>
      </label>
      <label className="alerts-switch">
        <input type="checkbox" checked={!popupsOff} onChange={togglePopups} disabled={permission === 'unsupported'} />
        <span>Mostrar notificação quando o Talk estiver em outra aba</span>
      </label>
      {permission === 'denied' && !popupsOff ? <p>O navegador está bloqueando as notificações. Libere no cadeado ao lado do endereço do site.</p> : null}
      <p>O número de conversas novas aparece no título da aba.</p>
    </div> : null}
  </div>;
}
