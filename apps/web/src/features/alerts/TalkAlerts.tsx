import { Bell, BellOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useOptionalTalkSession } from '../../app/session/TalkSessionProvider';
import { describeAlert, titleWithCount } from './alert-rules';
import { playAlertSound, unlockAlertSound } from './alert-sound';

const MUTED_KEY = 'talk-alerts-muted';
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
  const { session, currentUser } = useOptionalTalkSession()!;
  const [muted, setMuted] = useState(() => readFlag(MUTED_KEY));
  const [permission, setPermission] = useState(notificationPermission);
  const live = useRef({ activeModule, muted, onOpenConversation });
  live.current = { activeModule, muted, onOpenConversation };
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
      const notice = describeAlert(alert, currentUser.userId);
      if (!notice || live.current.muted) return;
      const here = personIsHere();
      const looking = here && live.current.activeModule === 'atendimento' &&
        session.readUI<string | null>('selectedConversation', null) === notice.conversationId;
      if (looking) return;
      const now = Date.now();
      if (now - lastSound.current > SOUND_GAP_MS || alert.kind === 'handoff') {
        lastSound.current = now; playAlertSound(alert.kind);
      }
      if (here) return;
      waiting.current.add(notice.conversationId); updateTitle();
      if (notificationPermission() !== 'granted') return;
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
  }, [session, currentUser.userId]);

  function toggle() {
    const next = !muted;
    setMuted(next); writeFlag(MUTED_KEY, next);
    if (!next && notificationPermission() === 'default') {
      void Notification.requestPermission().then(setPermission).catch(() => {});
    }
  }

  const label = muted ? 'Avisos desligados' : permission === 'denied'
    ? 'Avisos ligados (só som: notificações bloqueadas no navegador)' : 'Avisos ligados';
  const Icon = muted ? BellOff : Bell;
  return <button type="button" className={`rail-button rail-alerts${muted ? ' is-muted' : ''}`} onClick={toggle}
    aria-label={label} aria-pressed={!muted} title={label}>
    <Icon size={20} aria-hidden="true" />
    <span className="rail-label">{muted ? 'Avisos desligados' : 'Avisos ligados'}</span>
  </button>;
}
