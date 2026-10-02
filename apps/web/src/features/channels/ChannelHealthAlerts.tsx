import { useQuery } from "@tanstack/react-query";
import { useOptionalTalkSession } from "../../app/session/TalkSessionProvider";
import { apiGetChannelHealth, apiGetChannels } from "../../app/api";
import { describeChannelProblems, type ChannelProblem } from "./channel-problems";

export function ChannelHealthAlertList(props: { problems: ChannelProblem[]; onOpenChannels: () => void }) {
  if (props.problems.length === 0) return null;
  return <div className="channel-alerts" aria-live="polite">
    {props.problems.map((problem) => <div className={`channel-alert channel-alert-${problem.tone}`} role="alert" key={problem.channelId}>
      <strong>{problem.title}</strong>
      <p>{problem.detail}</p>
      <button type="button" className="secondary-button" onClick={props.onOpenChannels}>Abrir Canais</button>
    </div>)}
  </div>;
}

export function ChannelHealthAlerts(props: { onOpenChannels: () => void }) {
  const context = useOptionalTalkSession();
  if (!context) return null;
  return <ChannelHealthAlertsConnected {...props} />;
}

function ChannelHealthAlertsConnected(props: { onOpenChannels: () => void }) {
  const context = useOptionalTalkSession()!;
  const { session, getToken } = context;
  const channels = useQuery({ queryKey: session.key("channels"), staleTime: 60_000,
    queryFn: ({ signal }) => apiGetChannels(getToken, signal) });
  const health = useQuery({ queryKey: session.key("channelHealth"), staleTime: 60_000,
    queryFn: ({ signal }) => apiGetChannelHealth(getToken, signal) });
  const problems = describeChannelProblems(channels.data ?? [], health.data ?? []);
  return <ChannelHealthAlertList problems={problems} onOpenChannels={props.onOpenChannels} />;
}
