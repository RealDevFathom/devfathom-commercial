import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {Audio} from "@remotion/media";

const C = {
  ink: "#071714",
  forest: "#0E302B",
  teal: "#1F6A62",
  mint: "#A8E6D4",
  paper: "#F8F3E8",
  card: "#FFFDF7",
  brass: "#C8914D",
  amber: "#E3B15D",
  red: "#D65C4A",
  green: "#59A06F",
  blue: "#6AA4FF",
  line: "#E5D9C5",
  muted: "#6D746F",
  smoke: "rgba(248,243,232,.64)",
};

const display = '"Oxanium", "Avenir Next", sans-serif';
const sans = '"IBM Plex Sans", "Avenir Next", sans-serif';
const ease = Easing.bezier(0.16, 1, 0.3, 1);
const DURATION = 450;

const t = (
  frame: number,
  input: [number, number],
  output: [number, number],
) =>
  interpolate(frame, input, output, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

const inOut = (frame: number, start: number, end: number, fade = 18) =>
  Math.min(t(frame, [start, start + fade], [0, 1]), t(frame, [end - fade, end], [1, 0]));

const pop = (frame: number, start: number) =>
  spring({
    frame: frame - start,
    fps: 30,
    config: {damping: 18, stiffness: 120, mass: 0.8},
  });

const Grain = ({light = false}: {light?: boolean}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        opacity: light ? 0.045 : 0.075,
        backgroundImage: `repeating-linear-gradient(0deg, ${
          light ? "rgba(7,23,20,.2)" : "rgba(248,243,232,.22)"
        } 0px, transparent 1px, transparent 5px)`,
        transform: `translate(${Math.sin(frame * 0.52) * 1.2}px, ${Math.cos(frame * 0.37) * 1.2}px)`,
      }}
    />
  );
};

const Grid = ({light = false}: {light?: boolean}) => (
  <AbsoluteFill
    style={{
      opacity: light ? 0.06 : 0.08,
      backgroundImage: `linear-gradient(${light ? C.ink : C.paper} 1px, transparent 1px), linear-gradient(90deg, ${
        light ? C.ink : C.paper
      } 1px, transparent 1px)`,
      backgroundSize: "80px 80px",
    }}
  />
);

const Mark = ({size = 58}: {size?: number}) => (
  <Img src={staticFile("devfathom-icon.svg")} style={{width: size, height: size}} />
);

const Brand = ({dark = true}: {dark?: boolean}) => (
  <div
    style={{
      position: "absolute",
      top: 46,
      left: 56,
      zIndex: 20,
      display: "flex",
      alignItems: "center",
      gap: 12,
      color: dark ? C.paper : C.forest,
    }}
  >
    <Mark size={38} />
    <div style={{fontFamily: display, fontWeight: 700, fontSize: 19}}>
      DevFathom Hub
    </div>
  </div>
);

const Kicker = ({children, dark = true}: {children: React.ReactNode; dark?: boolean}) => (
  <div
    style={{
      fontFamily: sans,
      color: dark ? C.amber : C.teal,
      fontSize: 16,
      fontWeight: 700,
      letterSpacing: "0.15em",
      textTransform: "uppercase",
    }}
  >
    {children}
  </div>
);

const Headline = ({
  children,
  dark = true,
  size = 78,
  center = false,
}: {
  children: React.ReactNode;
  dark?: boolean;
  size?: number;
  center?: boolean;
}) => (
  <div
    style={{
      fontFamily: display,
      color: dark ? C.paper : C.ink,
      fontSize: size,
      lineHeight: 1.02,
      fontWeight: 700,
      letterSpacing: "0",
      textAlign: center ? "center" : "left",
    }}
  >
    {children}
  </div>
);

const Body = ({
  children,
  dark = true,
  width = 650,
}: {
  children: React.ReactNode;
  dark?: boolean;
  width?: number;
}) => (
  <div
    style={{
      fontFamily: sans,
      color: dark ? C.smoke : C.muted,
      fontSize: 24,
      lineHeight: 1.42,
      maxWidth: width,
    }}
  >
    {children}
  </div>
);

const Shell = ({
  children,
  light = false,
}: {
  children: React.ReactNode;
  light?: boolean;
}) => (
  <AbsoluteFill style={{background: light ? C.paper : C.ink, color: light ? C.ink : C.paper}}>
    <Grid light={light} />
    <Brand dark={!light} />
    {children}
    <Grain light={light} />
  </AbsoluteFill>
);

const Panel = ({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) => (
  <div
    style={{
      background: C.card,
      border: `1px solid ${C.line}`,
      borderRadius: 12,
      boxShadow: "0 28px 90px rgba(7,23,20,.16)",
      color: C.ink,
      ...style,
    }}
  >
    {children}
  </div>
);

const End = ({line, light = false}: {line: string; light?: boolean}) => {
  const frame = useCurrentFrame();
  const scale = 0.82 + pop(frame, 366) * 0.18;
  return (
    <AbsoluteFill
      style={{
        opacity: t(frame, [360, 390], [0, 1]),
        zIndex: 50,
        background: light ? C.paper : C.ink,
        color: light ? C.ink : C.paper,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Grid light={light} />
      <div style={{display: "flex", alignItems: "center", gap: 20, transform: `scale(${scale})`}}>
        <Mark size={96} />
        <div style={{fontFamily: display, fontWeight: 800, fontSize: 70}}>DevFathom</div>
      </div>
      <div
        style={{
          width: 620,
          height: 1,
          background: light ? C.line : "rgba(248,243,232,.18)",
          marginTop: 32,
          marginBottom: 26,
        }}
      />
      <div
        style={{
          fontFamily: display,
          color: light ? C.teal : C.amber,
          fontSize: 36,
          fontWeight: 700,
          textAlign: "center",
          maxWidth: 1050,
          lineHeight: 1.15,
        }}
      >
        {line}
      </div>
      <Grain light={light} />
    </AbsoluteFill>
  );
};

const MiniCard = ({
  label,
  title,
  value,
  color = C.teal,
  delay = 0,
}: {
  label: string;
  title: string;
  value?: string;
  color?: string;
  delay?: number;
}) => {
  const frame = useCurrentFrame();
  const reveal = t(frame, [delay, delay + 25], [0, 1]);
  return (
    <Panel
      style={{
        padding: "22px 24px",
        opacity: reveal,
        transform: `translateY(${(1 - reveal) * 30}px) scale(${0.96 + reveal * 0.04})`,
      }}
    >
      <div style={{fontFamily: sans, color: C.muted, fontSize: 13, letterSpacing: "0.13em"}}>
        {label}
      </div>
      <div style={{fontFamily: display, fontSize: 28, fontWeight: 800, marginTop: 10}}>
        {title}
      </div>
      {value ? (
        <div style={{fontFamily: sans, color, fontSize: 18, fontWeight: 700, marginTop: 12}}>
          {value}
        </div>
      ) : null}
    </Panel>
  );
};

const ModulesGraph = ({start = 100}: {start?: number}) => {
  const frame = useCurrentFrame();
  const modules = [
    ["CLIENTS", 690, 250, C.blue],
    ["PROJECTS", 990, 170, C.amber],
    ["PEOPLE", 1255, 310, C.mint],
    ["MEETINGS", 1270, 650, C.green],
    ["FINANCE", 975, 790, C.brass],
    ["KNOWLEDGE", 680, 650, C.teal],
  ] as const;
  const center = {x: 970, y: 500};
  return (
    <>
      {modules.map(([label, x0, y0, color], i) => {
        const reveal = t(frame, [start + i * 10, start + i * 10 + 24], [0, 1]);
        return (
          <React.Fragment key={label}>
            <div
              style={{
                position: "absolute",
                left: center.x,
                top: center.y,
                width: Math.hypot(x0 - center.x, y0 - center.y),
                height: 2,
                background: `linear-gradient(90deg, ${color}cc, transparent)`,
                transformOrigin: "left center",
                transform: `rotate(${Math.atan2(y0 - center.y, x0 - center.x)}rad) scaleX(${reveal})`,
                opacity: 0.7,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: x0,
                top: y0,
                transform: `translate(-50%,-50%) scale(${0.75 + reveal * 0.25})`,
                opacity: reveal,
                width: 168,
                height: 76,
                borderRadius: 14,
                background: "rgba(248,243,232,.08)",
                border: `1px solid ${color}99`,
                display: "grid",
                placeItems: "center",
                fontFamily: sans,
                color: C.paper,
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: "0.06em",
              }}
            >
              {label}
            </div>
          </React.Fragment>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: center.x,
          top: center.y,
          transform: `translate(-50%,-50%) scale(${0.78 + pop(frame, start + 55) * 0.22})`,
          opacity: t(frame, [start + 40, start + 70], [0, 1]),
          width: 154,
          height: 154,
          borderRadius: 999,
          background: C.paper,
          display: "grid",
          placeItems: "center",
          boxShadow: "0 0 70px rgba(200,145,77,.28)",
        }}
      >
        <Mark size={96} />
      </div>
    </>
  );
};

const MondayChaos = () => {
  const frame = useCurrentFrame();
  const tools = [
    ["Slack", "Who owns this?", 780, 145],
    ["Sheets", "Invoice status?", 1085, 120],
    ["Board", "Blocked task", 1425, 200],
    ["Notes", "Decision buried", 1510, 405],
    ["Calendar", "Missed follow-up", 760, 760],
    ["Email", "Scope change", 1320, 790],
  ] as const;
  return (
    <Shell>
      <div style={{position: "absolute", top: 156, left: 88, width: 610}}>
        <Kicker>Version 2 / The actual problem</Kicker>
        <div style={{marginTop: 20}}>
          <Headline>
            Status is everywhere.
            <br />
            Truth is nowhere.
          </Headline>
        </div>
        <div style={{marginTop: 26}}>
          <Body>
            DevFathom pulls the work, clients, people, meetings and money into one operating
            graph.
          </Body>
        </div>
      </div>
      {tools.map(([name, issue, left, top], i) => {
        const drift = Math.sin(frame * 0.025 + i) * 12;
        const fade = inOut(frame, 30 + i * 8, 168);
        return (
          <Panel
            key={name}
            style={{
              position: "absolute",
              left,
              top: top + drift,
              width: 260,
              padding: "20px",
              opacity: fade,
              transform: `rotate(${(i - 2) * 1.8}deg)`,
            }}
          >
            <div style={{fontFamily: sans, color: C.muted, fontSize: 13}}>{name}</div>
            <div style={{fontFamily: display, fontSize: 25, fontWeight: 800, marginTop: 10}}>
              {issue}
            </div>
          </Panel>
        );
      })}
      <div style={{opacity: inOut(frame, 160, 360)}}>
        <ModulesGraph start={160} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 92,
          textAlign: "center",
          opacity: t(frame, [255, 295], [0, 1]),
          fontFamily: display,
          fontSize: 44,
          fontWeight: 800,
          color: C.amber,
        }}
      >
        One company. One connected operating picture.
      </div>
      <End line="Stop chasing status. Start seeing the firm." />
      <Audio src={staticFile("soundtrack.wav")} volume={0.16} />
    </Shell>
  );
};

const AttentionQueue = () => {
  const frame = useCurrentFrame();
  const questions = [
    ["What changed?", "Atlas scope moved"],
    ["What is at risk?", "Milestone slips Friday"],
    ["Who owns it?", "Maya, Delivery lead"],
    ["What can I do?", "Approve capacity shift"],
  ] as const;
  return (
    <Shell light>
      <div style={{position: "absolute", top: 150, left: 86, width: 690}}>
        <Kicker dark={false}>The wedge</Kicker>
        <div style={{marginTop: 18}}>
          <Headline dark={false}>
            A daily queue for
            <br />
            the next clear action.
          </Headline>
        </div>
        <div style={{marginTop: 26}}>
          <Body dark={false}>
            Not another dashboard. A role-aware feed that explains attention, evidence,
            ownership and safe action.
          </Body>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 88,
          top: 138,
          width: 820,
          bottom: 88,
          display: "grid",
          gridTemplateRows: "repeat(4, 1fr)",
          gap: 18,
        }}
      >
        {questions.map(([q, answer], i) => (
          <Panel
            key={q}
            style={{
              padding: "24px 28px",
              display: "flex",
              alignItems: "center",
              gap: 22,
              opacity: t(frame, [55 + i * 34, 84 + i * 34], [0, 1]),
              transform: `translateX(${t(frame, [55 + i * 34, 84 + i * 34], [70, 0])}px)`,
            }}
          >
            <div
              style={{
                width: 58,
                height: 58,
                borderRadius: 999,
                background: i === 3 ? C.teal : C.paper,
                color: i === 3 ? C.paper : C.teal,
                display: "grid",
                placeItems: "center",
                fontFamily: display,
                fontSize: 22,
                fontWeight: 800,
                border: `1px solid ${C.line}`,
              }}
            >
              {i + 1}
            </div>
            <div style={{flex: 1}}>
              <div style={{fontFamily: sans, color: C.muted, fontSize: 16}}>{q}</div>
              <div style={{fontFamily: display, fontWeight: 800, fontSize: 34, marginTop: 6}}>
                {answer}
              </div>
            </div>
          </Panel>
        ))}
      </div>
      <End line="Know what matters, why, who owns it, and what to do." light />
      <Audio src={staticFile("soundtrack.wav")} volume={0.14} />
    </Shell>
  );
};

const ClientToCash = () => {
  const frame = useCurrentFrame();
  const steps = ["Lead", "Contract", "Project", "Time", "Invoice", "Paid"];
  const progress = t(frame, [70, 286], [0, 1]);
  return (
    <Shell>
      <div style={{position: "absolute", top: 150, left: 86, width: 760}}>
        <Kicker>Service firm reality</Kicker>
        <div style={{marginTop: 18}}>
          <Headline>
            Revenue is a chain.
            <br />
            DevFathom keeps it linked.
          </Headline>
        </div>
        <div style={{marginTop: 26}}>
          <Body>
            The same client context travels from promise, to delivery, to invoice, to cash.
          </Body>
        </div>
      </div>
      <div style={{position: "absolute", left: 120, right: 120, top: 642}}>
        <div style={{height: 5, background: "rgba(248,243,232,.16)", borderRadius: 99}}>
          <div style={{height: "100%", width: `${progress * 100}%`, background: C.amber}} />
        </div>
        {steps.map((step, i) => {
          const reveal = t(frame, [70 + i * 28, 98 + i * 28], [0, 1]);
          return (
            <div
              key={step}
              style={{
                position: "absolute",
                left: `${(i / (steps.length - 1)) * 100}%`,
                top: -48,
                transform: `translateX(-50%) scale(${0.74 + reveal * 0.26})`,
                opacity: reveal,
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: 98,
                  height: 98,
                  borderRadius: 999,
                  background: i === steps.length - 1 ? C.amber : C.paper,
                  color: C.ink,
                  border: `9px solid ${C.ink}`,
                  display: "grid",
                  placeItems: "center",
                  fontFamily: display,
                  fontSize: 27,
                  fontWeight: 800,
                }}
              >
                {i + 1}
              </div>
              <div style={{fontFamily: sans, fontSize: 20, marginTop: 12, fontWeight: 700}}>
                {step}
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          right: 92,
          top: 170,
          width: 440,
          opacity: t(frame, [245, 290], [0, 1]),
        }}
      >
        <MiniCard label="Cash action" title="$18,400 overdue" value="Draft reminder ready" />
      </div>
      <End line="Client to cash without losing the thread." />
      <Audio src={staticFile("soundtrack.wav")} volume={0.14} />
    </Shell>
  );
};

const EarlyRisk = () => {
  const frame = useCurrentFrame();
  const risk = t(frame, [80, 190], [14, 76]);
  const items = [
    ["Blocked task", "2 days idle", C.red],
    ["Owner gap", "No active lead", C.amber],
    ["Capacity conflict", "Leave overlaps", C.blue],
    ["Cash drift", "Invoice aging", C.brass],
  ] as const;
  return (
    <Shell light>
      <div style={{position: "absolute", left: 86, top: 148, width: 720}}>
        <Kicker dark={false}>Before it is late</Kicker>
        <div style={{marginTop: 18}}>
          <Headline dark={false}>
            Friday problems
            <br />
            start on Tuesday.
          </Headline>
        </div>
        <div style={{marginTop: 26}}>
          <Body dark={false}>
            DevFathom notices the signals while there is still time to change the outcome.
          </Body>
        </div>
      </div>
      <Panel
        style={{
          position: "absolute",
          right: 96,
          top: 130,
          width: 610,
          height: 610,
          padding: 36,
          overflow: "hidden",
        }}
      >
        <div style={{fontFamily: sans, color: C.muted, fontSize: 14, letterSpacing: "0.13em"}}>
          PROJECT ATLAS
        </div>
        <div style={{fontFamily: display, fontSize: 48, fontWeight: 800, marginTop: 12}}>
          Launch readiness
        </div>
        <div style={{marginTop: 38}}>
          <div style={{display: "flex", justifyContent: "space-between", fontFamily: sans}}>
            <span>Risk score</span>
            <span style={{color: risk > 60 ? C.red : C.amber, fontWeight: 800}}>
              {Math.round(risk)}%
            </span>
          </div>
          <div style={{height: 16, background: C.line, borderRadius: 99, marginTop: 12}}>
            <div
              style={{
                height: "100%",
                width: `${risk}%`,
                background: risk > 60 ? C.red : C.amber,
                borderRadius: 99,
              }}
            />
          </div>
        </div>
        <div style={{display: "grid", gap: 14, marginTop: 34}}>
          {items.map(([title, meta, color], i) => {
            const reveal = t(frame, [116 + i * 26, 145 + i * 26], [0, 1]);
            return (
              <div
                key={title}
                style={{
                  opacity: reveal,
                  transform: `translateY(${(1 - reveal) * 24}px)`,
                  border: `1px solid ${C.line}`,
                  borderLeft: `7px solid ${color}`,
                  borderRadius: 10,
                  padding: "17px 18px",
                  fontFamily: sans,
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span style={{fontWeight: 800}}>{title}</span>
                <span style={{color: C.muted}}>{meta}</span>
              </div>
            );
          })}
        </div>
      </Panel>
      <div
        style={{
          position: "absolute",
          left: 86,
          bottom: 98,
          opacity: t(frame, [255, 300], [0, 1]),
        }}
      >
        <Headline dark={false} size={44}>
          Evidence, owner, next action. Not panic.
        </Headline>
      </div>
      <End line="See risk while it is still manageable." light />
      <Audio src={staticFile("soundtrack.wav")} volume={0.14} />
    </Shell>
  );
};

const AskOperator = () => {
  const frame = useCurrentFrame();
  const scan = t(frame, [98, 218], [0, 1]);
  return (
    <Shell>
      <div style={{position: "absolute", left: 86, top: 158, width: 620}}>
        <Kicker>AI operator</Kicker>
        <div style={{marginTop: 18}}>
          <Headline>
            Ask the firm.
            <br />
            Not a blank chat box.
          </Headline>
        </div>
        <div style={{marginTop: 26}}>
          <Body>
            The operator works over the same permission-aware records your team already uses.
          </Body>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 86,
          top: 130,
          width: 820,
          height: 720,
          borderRadius: 20,
          border: "1px solid rgba(248,243,232,.17)",
          background: "rgba(14,48,43,.86)",
          padding: 34,
        }}
      >
        <div style={{fontFamily: sans, color: C.amber, letterSpacing: "0.14em", fontSize: 14}}>
          DEVFATHOM OPERATOR
        </div>
        <div style={{fontFamily: display, fontSize: 35, fontWeight: 800, marginTop: 30}}>
          What needs attention before Friday?
        </div>
        <div style={{height: 3, background: "rgba(248,243,232,.13)", marginTop: 30}}>
          <div style={{height: "100%", width: `${scan * 100}%`, background: C.amber}} />
        </div>
        <div style={{display: "flex", gap: 12, marginTop: 20}}>
          {["Projects", "People", "Meetings", "Finance", "Notes"].map((label, i) => (
            <div
              key={label}
              style={{
                padding: "9px 12px",
                borderRadius: 999,
                fontFamily: sans,
                fontSize: 13,
                background: scan > (i + 1) / 6 ? "rgba(200,145,77,.2)" : "rgba(248,243,232,.07)",
                color: scan > (i + 1) / 6 ? C.amber : "rgba(248,243,232,.48)",
              }}
            >
              {label}
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: 40,
            opacity: t(frame, [224, 260], [0, 1]),
            transform: `translateY(${t(frame, [224, 260], [36, 0])}px)`,
          }}
        >
          <div style={{fontFamily: display, fontSize: 38, fontWeight: 800}}>
            3 actions found. 1 requires approval.
          </div>
          {[
            ["Approve capacity shift", "Policy check passed"],
            ["Send invoice reminder", "Draft ready"],
            ["Resolve scope decision", "Evidence attached"],
          ].map(([title, meta], i) => (
            <div
              key={title}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "21px 0",
                borderBottom: "1px solid rgba(248,243,232,.12)",
                fontFamily: sans,
                fontSize: 19,
              }}
            >
              <span>
                <span style={{color: C.amber, marginRight: 14}}>0{i + 1}</span>
                {title}
              </span>
              <span style={{color: C.smoke, fontSize: 15}}>{meta}</span>
            </div>
          ))}
        </div>
      </div>
      <End line="AI proposes. Policy decides. Humans approve." />
      <Audio src={staticFile("soundtrack.wav")} volume={0.14} />
    </Shell>
  );
};

const LeadershipView = () => {
  const frame = useCurrentFrame();
  return (
    <Shell light>
      <div style={{position: "absolute", top: 142, left: 86, right: 86}}>
        <Kicker dark={false}>Founder view</Kicker>
        <div style={{marginTop: 18}}>
          <Headline dark={false}>
            Delivery, cash and capacity
            <br />
            on the same page.
          </Headline>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 86,
          right: 86,
          bottom: 108,
          display: "grid",
          gridTemplateColumns: "1.1fr 1fr 1fr",
          gap: 18,
        }}
      >
        <MiniCard label="Delivery risk" title="3 projects need help" value="2 owners assigned" delay={100} />
        <MiniCard label="Cash action" title="$42.8k to follow up" value="4 reminders ready" color={C.brass} delay={130} />
        <MiniCard label="Capacity" title="18% over planned load" value="Rebalance suggested" color={C.red} delay={160} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 86,
          top: 426,
          width: 1748,
          height: 235,
          borderRadius: 14,
          border: `1px solid ${C.line}`,
          background: C.card,
          padding: 26,
          opacity: t(frame, [185, 225], [0, 1]),
        }}
      >
        <div style={{fontFamily: sans, color: C.muted, fontSize: 14, letterSpacing: "0.13em"}}>
          ATTENTION QUEUE
        </div>
        <div style={{display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 16, marginTop: 22}}>
          {["Atlas milestone", "Owner", "Evidence", "Approve"].map((item, i) => (
            <div
              key={item}
              style={{
                background: i === 3 ? C.teal : C.paper,
                color: i === 3 ? C.paper : C.ink,
                borderRadius: 10,
                padding: "24px",
                fontFamily: display,
                fontSize: 27,
                fontWeight: 800,
              }}
            >
              {item}
            </div>
          ))}
        </div>
      </div>
      <End line="The whole firm, reduced to the next decisions." light />
      <Audio src={staticFile("soundtrack.wav")} volume={0.14} />
    </Shell>
  );
};

const UpdateOnce = () => {
  const frame = useCurrentFrame();
  const sources = [
    ["Project", "Scope changed"],
    ["Client", "Commitment updated"],
    ["Finance", "Margin recalculated"],
    ["Team", "Capacity adjusted"],
    ["Report", "Status refreshed"],
  ] as const;
  const pulse = t(frame, [112, 230], [0, 1]);
  return (
    <Shell>
      <div style={{position: "absolute", left: 86, top: 150, width: 650}}>
        <Kicker>No duplicate reporting</Kicker>
        <div style={{marginTop: 18}}>
          <Headline>
            Update once.
            <br />
            Let context travel.
          </Headline>
        </div>
        <div style={{marginTop: 26}}>
          <Body>
            When the work changes, everyone downstream sees the operational consequence.
          </Body>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 890,
          top: 350,
          width: 280,
          height: 280,
          borderRadius: 999,
          background: C.paper,
          display: "grid",
          placeItems: "center",
          boxShadow: `0 0 ${40 + pulse * 90}px rgba(200,145,77,.32)`,
        }}
      >
        <Mark size={164} />
      </div>
      {sources.map(([name, change], i) => {
        const angle = -80 + i * 40;
        const rad = (angle * Math.PI) / 180;
        const left = 1060 + Math.cos(rad) * (220 + pulse * 235);
        const top = 545 + Math.sin(rad) * (70 + pulse * 165);
        const reveal = t(frame, [132 + i * 22, 160 + i * 22], [0, 1]);
        return (
          <Panel
            key={name}
            style={{
              position: "absolute",
              left,
              top,
              width: 300,
              padding: "20px 22px",
              opacity: reveal,
              transform: "translate(-50%,-50%)",
            }}
          >
            <div style={{fontFamily: sans, color: C.muted, fontSize: 13}}>{name}</div>
            <div style={{fontFamily: display, fontSize: 25, fontWeight: 800, marginTop: 8}}>
              {change}
            </div>
          </Panel>
        );
      })}
      <End line="Less reporting. More shared truth." />
      <Audio src={staticFile("soundtrack.wav")} volume={0.14} />
    </Shell>
  );
};

const ProofControl = () => {
  const frame = useCurrentFrame();
  const rows = [
    ["Evidence", "Meeting note, task history, invoice"],
    ["Permission", "Only authorized actions shown"],
    ["Audit", "Actor, timestamp, before and after"],
  ] as const;
  return (
    <Shell light>
      <div style={{position: "absolute", left: 86, top: 150, width: 720}}>
        <Kicker dark={false}>Trust layer</Kicker>
        <div style={{marginTop: 18}}>
          <Headline dark={false}>
            The platform does not
            <br />
            ask you to trust magic.
          </Headline>
        </div>
        <div style={{marginTop: 26}}>
          <Body dark={false}>
            Every recommendation needs evidence, permission and a trail. Useful AI, controlled by
            operating rules.
          </Body>
        </div>
      </div>
      <div style={{position: "absolute", right: 90, top: 190, width: 720}}>
        {rows.map(([title, detail], i) => {
          const reveal = t(frame, [90 + i * 48, 124 + i * 48], [0, 1]);
          return (
            <Panel
              key={title}
              style={{
                padding: "30px 34px",
                marginBottom: 20,
                opacity: reveal,
                transform: `translateX(${(1 - reveal) * 60}px)`,
              }}
            >
              <div style={{fontFamily: display, fontSize: 36, fontWeight: 800}}>{title}</div>
              <div style={{fontFamily: sans, color: C.muted, fontSize: 21, marginTop: 10}}>
                {detail}
              </div>
            </Panel>
          );
        })}
      </div>
      <End line="Recommendations with evidence, guardrails and audit." light />
      <Audio src={staticFile("soundtrack.wav")} volume={0.14} />
    </Shell>
  );
};

const ServicesOS = () => {
  const frame = useCurrentFrame();
  const nodes = [
    "Clients",
    "Contracts",
    "Projects",
    "Tasks",
    "Meetings",
    "People",
    "Invoices",
    "AI actions",
  ];
  return (
    <Shell>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          textAlign: "center",
        }}
      >
        <Kicker>Category</Kicker>
        <div style={{marginTop: 22}}>
          <Headline center size={88}>
            The internal delivery
            <br />
            operating system.
          </Headline>
        </div>
        <div style={{marginTop: 30}}>
          <Body width={920}>
            Built for services teams that need delivery, client commitments, cash, people,
            communication and AI to share the same context.
          </Body>
        </div>
      </div>
      {nodes.map((node, i) => {
        const angle = (i / nodes.length) * Math.PI * 2 + frame * 0.004;
        const reveal = t(frame, [60 + i * 10, 90 + i * 10], [0, 1]);
        return (
          <div
            key={node}
            style={{
              position: "absolute",
              left: 960 + Math.cos(angle) * 700,
              top: 540 + Math.sin(angle) * 355,
              transform: `translate(-50%,-50%) scale(${0.8 + reveal * 0.2})`,
              opacity: reveal * 0.8,
              border: "1px solid rgba(248,243,232,.22)",
              borderRadius: 999,
              padding: "13px 18px",
              fontFamily: sans,
              color: C.paper,
              background: "rgba(248,243,232,.06)",
              fontWeight: 700,
            }}
          >
            {node}
          </div>
        );
      })}
      <End line="One system for the work behind the work." />
      <Audio src={staticFile("soundtrack.wav")} volume={0.14} />
    </Shell>
  );
};

const Outcome = () => {
  const frame = useCurrentFrame();
  const words = [
    ["Fewer surprises", C.green],
    ["Clearer owners", C.amber],
    ["Faster decisions", C.blue],
    ["Less status chasing", C.mint],
  ] as const;
  return (
    <Shell light>
      <div style={{position: "absolute", left: 86, top: 150, width: 720}}>
        <Kicker dark={false}>The payoff</Kicker>
        <div style={{marginTop: 18}}>
          <Headline dark={false}>
            The work is still hard.
            <br />
            The picture gets clearer.
          </Headline>
        </div>
        <div style={{marginTop: 26}}>
          <Body dark={false}>
            DevFathom helps teams see attention, evidence, ownership and action before work turns
            into emergency.
          </Body>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 90,
          top: 150,
          width: 740,
          display: "grid",
          gap: 18,
        }}
      >
        {words.map(([word, color], i) => {
          const reveal = t(frame, [80 + i * 38, 112 + i * 38], [0, 1]);
          return (
            <div
              key={word}
              style={{
                opacity: reveal,
                transform: `translateX(${(1 - reveal) * 70}px)`,
                background: C.card,
                border: `1px solid ${C.line}`,
                borderLeft: `9px solid ${color}`,
                borderRadius: 12,
                padding: "32px 34px",
                fontFamily: display,
                fontSize: 44,
                fontWeight: 800,
                color: C.ink,
                boxShadow: "0 25px 80px rgba(7,23,20,.12)",
              }}
            >
              {word}
            </div>
          );
        })}
      </div>
      <End line="DevFathom Hub. Know what needs attention next." light />
      <Audio src={staticFile("soundtrack.wav")} volume={0.14} />
    </Shell>
  );
};

const films = [
  MondayChaos,
  AttentionQueue,
  ClientToCash,
  EarlyRisk,
  AskOperator,
  LeadershipView,
  UpdateOnce,
  ProofControl,
  ServicesOS,
  Outcome,
];

export const CONCEPTS = [
  {id: "01-Fragmented-To-One", index: 0, title: "Status Is Everywhere"},
  {id: "02-Before-Its-Urgent", index: 1, title: "Attention Queue"},
  {id: "03-Client-To-Cash", index: 2, title: "Client To Cash"},
  {id: "04-Same-Live-Context", index: 3, title: "Early Risk"},
  {id: "05-Ask-One-Question", index: 4, title: "Ask The Operator"},
  {id: "06-Monday-Reading", index: 5, title: "Founder View"},
  {id: "07-Built-For-Services", index: 6, title: "Update Once"},
  {id: "08-Update-Once", index: 7, title: "Proof And Control"},
  {id: "09-Noise-To-Signal", index: 8, title: "Services OS"},
  {id: "10-The-Outcome", index: 9, title: "Outcome"},
] as const;

export const ConceptFilm: React.FC<{concept: number}> = ({concept}) => {
  const Film = films[concept] ?? films[0];
  return (
    <AbsoluteFill>
      <Film />
    </AbsoluteFill>
  );
};
