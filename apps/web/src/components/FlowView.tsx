import {
  CalendarClock,
  Check,
  Clock,
  Cloud,
  Cpu,
  Filter,
  GitBranch,
  Hourglass,
  Radio,
  X,
  Zap,
} from 'lucide-react';
import { Fragment } from 'react';
import { type Flow, type FlowNode, fires } from '../flow.ts';
import type { Run } from '../live.ts';
import { type DeviceIndex, ms, valueText } from '../util.ts';

interface Props {
  flow: Flow;
  run?: Run;
  idx: DeviceIndex;
  local: boolean;
  now: number;
  hover?: string;
  onHover: (id: string | undefined) => void;
}

/** WHEN → ONLY IF → DO, drawn from the compiled rule and lit by the run in view. */
export function FlowView({ flow, run, idx, local, now, hover, onHover }: Props) {
  const hub = [...flow.starts, ...flow.steps]
    .flatMap((n) =>
      n.kind === 'trigger' ? n.dev.deviceIds : n.kind === 'command' ? n.deviceIds : [],
    )
    .map(idx.hubOf)
    .find(Boolean);
  const anyDone = run
    ? Object.values(run.steps).some((s) => s.state === 'done' && 'event' in s && s.event)
    : false;
  const allMissed = run ? run.closed === 'timeout' && !anyDone : false;
  return (
    <div className="flow">
      <Column title="When" icon={<Zap size={12} />}>
        {flow.starts.map((n) => (
          <Node key={n.id} node={n} run={run} idx={idx} now={now} hover={hover} onHover={onHover} />
        ))}
      </Column>
      {flow.guards.length > 0 && (
        <Column title="Only if" icon={<Filter size={12} />}>
          {flow.guards.map((n) => (
            <Node
              key={n.id}
              node={n}
              run={run}
              idx={idx}
              now={now}
              hover={hover}
              onHover={onHover}
              guard={run ? (anyDone ? 'pass' : allMissed ? 'unknown' : 'eval') : undefined}
            />
          ))}
        </Column>
      )}
      <Column
        title="Do"
        icon={local ? <Cpu size={12} /> : <Cloud size={12} />}
        note={local ? `on ${hub ?? 'the hub'}` : 'in SmartThings cloud'}
        wide
      >
        <div className="steps">
          {flow.steps.map((n, i) => (
            <Fragment key={n.id}>
              {i > 0 && <span className="step-arrow" aria-hidden />}
              <Node node={n} run={run} idx={idx} now={now} hover={hover} onHover={onHover} />
            </Fragment>
          ))}
        </div>
        {flow.otherwise.length > 0 && (
          <div className="otherwise">
            <span className="col-sub">otherwise</span>
            <div className="steps">
              {flow.otherwise.map((n) => (
                <Node key={n.id} node={n} idx={idx} now={now} hover={hover} onHover={onHover} />
              ))}
            </div>
          </div>
        )}
      </Column>
    </div>
  );
}

function Column({
  title,
  icon,
  note,
  wide,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  note?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`flow-col ${wide ? 'wide' : ''}`}>
      <div className="col-h">
        {icon}
        {title}
        {note && <span className="col-note">{note}</span>}
      </div>
      <div className="col-body">{children}</div>
    </div>
  );
}

function Node({
  node,
  run,
  idx,
  now,
  hover,
  onHover,
  guard,
}: {
  node: FlowNode;
  run?: Run | undefined;
  idx: DeviceIndex;
  now: number;
  hover?: string | undefined;
  onHover: (id: string | undefined) => void;
  guard?: 'pass' | 'unknown' | 'eval' | undefined;
}) {
  const step = run?.steps[node.id];
  let state = 'idle';
  let foot: React.ReactNode = null;
  let progress: number | undefined;

  if (node.kind === 'trigger' && run?.trigger && fires(node, run.trigger)) {
    state = 'fired';
    foot = (
      <>
        <Radio size={11} /> {valueText(run.trigger.value)} · seen{' '}
        {ms(run.trigger.receivedAt - run.trigger.eventTime)} after
      </>
    );
  } else if (node.kind === 'guard' && guard) {
    state = guard === 'pass' ? 'done' : guard === 'unknown' ? 'missed' : 'pending';
    foot =
      guard === 'pass' ? (
        'held: a step ran'
      ) : guard === 'unknown' ? (
        'no step ran: did it fail?'
      ) : (
        <span className="dots">evaluating</span>
      );
  } else if (step) {
    if (step.state === 'done') {
      state = 'done';
      if (step.event && run) {
        const from = run.trigger?.eventTime ?? run.openedAt;
        foot = (
          <>
            <Check size={11} /> {valueText(step.event.value)}
            {node.kind === 'command' && <> · +{ms(step.event.eventTime - from)}</>}
          </>
        );
      } else foot = <Check size={11} />;
    } else if (step.state === 'waiting') {
      state = 'active';
      progress = Math.min(1, (now - step.from) / (step.until - step.from));
      foot = <>{ms(step.until - now)} left</>;
    } else if (step.state === 'missed') {
      state = 'missed';
      foot = (
        <>
          <X size={11} /> no device event
        </>
      );
    } else if (step.state === 'pending' && run && !run.closed) {
      state = 'pending';
      foot = <span className="dots">waiting for device event</span>;
    }
  }

  const key = `${node.id}:${state}:${run?.id ?? ''}`;
  const common = {
    className: `node node-${node.kind} st-${state} ${hover === node.id ? 'is-hover' : ''}`,
    onMouseEnter: () => onHover(node.id),
    onMouseLeave: () => onHover(undefined),
  };

  let icon: React.ReactNode;
  let head: React.ReactNode;
  let body: React.ReactNode;
  let where: string | undefined;
  switch (node.kind) {
    case 'trigger':
      icon = <Zap size={13} />;
      head = node.dev.deviceIds.map(idx.label).join(', ');
      body = (
        <>
          <span className="mono">
            {node.dev.capability}.{node.dev.attribute}
          </span>{' '}
          <span className="op">{node.op}</span> <span className="mono val">{node.value}</span>
        </>
      );
      break;
    case 'schedule':
      icon = <CalendarClock size={13} />;
      head = 'Schedule';
      body = node.label;
      break;
    case 'guard':
      icon = <Filter size={13} />;
      head = node.dev
        ? node.dev.deviceIds.map(idx.label).join(', ')
        : node.label.startsWith('location.mode')
          ? 'Location mode'
          : node.label.includes('now')
            ? 'Time of day'
            : 'Condition';
      body = <span className="mono">{node.label}</span>;
      break;
    case 'command':
      icon = <Zap size={13} />;
      head = node.deviceIds.map(idx.label).join(', ');
      body = (
        <span className="mono">
          {node.capability}.<b>{node.command}</b>({node.args.join(', ')})
        </span>
      );
      if (!node.deviceIds.some((d) => idx.hubOf(d))) where = 'cloud device';
      break;
    case 'sleep':
      icon = <Hourglass size={13} />;
      head = 'Sleep';
      body = <span className="mono">{ms(node.seconds * 1000)}</span>;
      break;
    case 'mode':
      icon = <Clock size={13} />;
      head = 'Set mode';
      body = <span className="mono">{node.modeId}</span>;
      break;
    case 'branch':
      icon = <GitBranch size={13} />;
      head = 'If';
      body = <span className="mono">{node.label}</span>;
      break;
  }

  return (
    <div {...common} key={key}>
      <div className="node-h">
        <span className="node-icon">{icon}</span>
        <span className="node-title">{head}</span>
        {where && <span className="node-where">{where}</span>}
      </div>
      <div className="node-b">{body}</div>
      {progress !== undefined && (
        <div className="node-progress">
          <span style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {foot && <div className="node-f">{foot}</div>}
    </div>
  );
}
