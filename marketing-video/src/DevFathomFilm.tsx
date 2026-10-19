import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {Audio} from "@remotion/media";

const C = {
  abyss: "#08221F",
  abyss2: "#0C2E2C",
  brand: "#123A38",
  teal: "#245C57",
  paper: "#F7F5EF",
  card: "#FDFCF8",
  ink: "#161A19",
  muted: "#6E7570",
  line: "#E3DDD0",
  brass: "#BC8850",
  success: "#3E6B52",
  warning: "#9C7A3A",
} as const;

const display = '"Oxanium", "Avenir Next", sans-serif';
const sans = '"IBM Plex Sans", "Avenir Next", sans-serif';
const expo = Easing.bezier(0.16, 1, 0.3, 1);

const clamp = (value: number, input: [number, number], output: [number, number]) =>
  interpolate(value, input, output, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: expo,
  });

const sceneOpacity = (frame: number, start: number, end: number, fade = 18) =>
  Math.min(
    clamp(frame, [start, start + fade], [0, 1]),
    clamp(frame, [end - fade, end], [1, 0]),
  );

const Mark = ({size = 84, tile = true}: {size?: number; tile?: boolean}) => (
  <Img
    src={staticFile(tile ? "devfathom-icon.svg" : "devfathom-mark-white.svg")}
    style={{width: size, height: size, objectFit: "contain"}}
  />
);

const Grain = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        opacity: 0.12,
        backgroundImage:
          "radial-gradient(circle at 20% 10%, rgba(188,136,80,.2), transparent 24%), radial-gradient(circle at 80% 85%, rgba(36,92,87,.18), transparent 30%), repeating-linear-gradient(0deg, rgba(255,255,255,.018) 0px, rgba(255,255,255,.018) 1px, transparent 1px, transparent 4px)",
        transform: `translate(${Math.sin(frame * 0.71) * 2}px, ${Math.cos(frame * 0.47) * 2}px)`,
      }}
    />
  );
};

const Grid = ({dark = true}: {dark?: boolean}) => (
  <AbsoluteFill
    style={{
      opacity: dark ? 0.055 : 0.05,
      backgroundImage: `linear-gradient(${dark ? "#F7F5EF" : "#123A38"} 1px, transparent 1px), linear-gradient(90deg, ${dark ? "#F7F5EF" : "#123A38"} 1px, transparent 1px)`,
      backgroundSize: "72px 72px",
    }}
  />
);

const MicroLabel = ({children, dark = true}: {children: React.ReactNode; dark?: boolean}) => (
  <div
    style={{
      fontFamily: sans,
      fontSize: 17,
      fontWeight: 600,
      letterSpacing: "0.16em",
      textTransform: "uppercase",
      color: dark ? C.brass : C.brand,
    }}
  >
    {children}
  </div>
);

const OrbitPill = ({
  label,
  x,
  y,
  delay,
}: {
  label: string;
  x: number;
  y: number;
  delay: number;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - delay, fps, config: {damping: 18, stiffness: 120}});
  const drift = Math.sin((frame + delay) / 28) * 7;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y + drift,
        transform: `translate(-50%, -50%) scale(${0.72 + s * 0.28})`,
        opacity: s,
        padding: "15px 24px",
        borderRadius: 999,
        border: "1px solid rgba(247,245,239,.18)",
        background: "rgba(12,46,44,.82)",
        backdropFilter: "blur(14px)",
        color: C.paper,
        fontFamily: sans,
        fontSize: 20,
        fontWeight: 500,
        letterSpacing: "0.01em",
        boxShadow: "0 24px 80px rgba(0,0,0,.18)",
      }}
    >
      {label}
    </div>
  );
};

const Intro = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const opacity = sceneOpacity(frame, 0, 138, 20);
  const logo = spring({frame: frame - 10, fps, config: {damping: 16, stiffness: 90}});
  const titleY = clamp(frame, [22, 55], [70, 0]);
  const titleOpacity = clamp(frame, [18, 44], [0, 1]);
  const line = clamp(frame, [8, 62], [0, 1]);

  return (
    <AbsoluteFill style={{opacity, backgroundColor: C.abyss, color: C.paper}}>
      <Grid />
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 960,
          width: 1,
          background: "rgba(247,245,239,.12)",
          transform: `scaleY(${line})`,
        }}
      />
      <OrbitPill label="Projects" x={370} y={270} delay={34} />
      <OrbitPill label="Clients" x={1550} y={260} delay={41} />
      <OrbitPill label="Finance" x={305} y={765} delay={50} />
      <OrbitPill label="People" x={1620} y={760} delay={57} />
      <OrbitPill label="Meetings" x={590} y={900} delay={64} />
      <OrbitPill label="Realtime" x={1335} y={900} delay={71} />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          transform: `translateY(${titleY}px)`,
          opacity: titleOpacity,
        }}
      >
        <div style={{transform: `scale(${0.7 + logo * 0.3})`, marginBottom: 32}}>
          <Mark size={126} />
        </div>
        <MicroLabel>DevFathom Hub</MicroLabel>
        <div
          style={{
            fontFamily: display,
            fontSize: 92,
            fontWeight: 600,
            lineHeight: 1.03,
            letterSpacing: "-0.045em",
            textAlign: "center",
            maxWidth: 1120,
            marginTop: 22,
          }}
        >
          Everything moving.
          <br />
          <span style={{color: C.brass}}>Finally aligned.</span>
        </div>
      </div>
      <Grain />
    </AbsoluteFill>
  );
};

const SidebarItem = ({label, active = false}: {label: string; active?: boolean}) => (
  <div
    style={{
      height: 48,
      display: "flex",
      alignItems: "center",
      gap: 14,
      padding: "0 15px",
      borderRadius: 11,
      color: active ? C.paper : "rgba(247,245,239,.6)",
      background: active ? "rgba(247,245,239,.09)" : "transparent",
      fontFamily: sans,
      fontSize: 16,
      position: "relative",
    }}
  >
    {active ? (
      <div style={{position: "absolute", left: -1, width: 3, height: 22, borderRadius: 9, background: C.brass}} />
    ) : null}
    <div style={{width: 17, height: 17, border: "1.5px solid currentColor", borderRadius: active ? 4 : 999}} />
    {label}
  </div>
);

const Kpi = ({label, value, note}: {label: string; value: string; note: string}) => (
  <div style={{padding: "25px 26px", flex: 1, borderRight: `1px solid ${C.line}`}}>
    <div style={{fontFamily: sans, textTransform: "uppercase", letterSpacing: ".13em", fontSize: 12, color: C.muted}}>{label}</div>
    <div style={{fontFamily: display, fontSize: 35, fontWeight: 600, color: C.ink, marginTop: 8}}>{value}</div>
    <div style={{fontFamily: sans, fontSize: 13, color: C.success, marginTop: 5}}>{note}</div>
  </div>
);

const Dashboard = () => {
  const frame = useCurrentFrame();
  const local = frame - 102;
  const {fps} = useVideoConfig();
  const reveal = spring({frame: local, fps, config: {damping: 18, stiffness: 80}});
  const float = Math.sin(frame / 34) * 5;
  const barHeights = [46, 62, 54, 81, 69, 94, 88, 106, 98, 126, 118, 142];
  return (
    <div
      style={{
        width: 1510,
        height: 760,
        borderRadius: 28,
        overflow: "hidden",
        background: C.paper,
        display: "flex",
        boxShadow: "0 60px 160px rgba(0,0,0,.28)",
        border: "1px solid rgba(255,255,255,.25)",
        transform: `perspective(1600px) rotateX(${(1 - reveal) * 12}deg) translateY(${(1 - reveal) * 180 + float}px) scale(${0.9 + reveal * 0.1})`,
        opacity: reveal,
      }}
    >
      <div style={{width: 235, background: C.abyss, padding: "26px 18px"}}>
        <div style={{display: "flex", alignItems: "center", gap: 12, margin: "0 10px 32px"}}>
          <Mark size={42} />
          <div style={{fontFamily: display, fontSize: 18, fontWeight: 600, color: C.paper}}>DevFathom</div>
        </div>
        <SidebarItem label="Overview" active />
        <SidebarItem label="Projects" />
        <SidebarItem label="Clients" />
        <SidebarItem label="Finance" />
        <SidebarItem label="People" />
        <SidebarItem label="Meetings" />
        <SidebarItem label="Chat" />
      </div>

      <div style={{flex: 1, padding: "36px 42px", overflow: "hidden"}}>
        <div style={{display: "flex", justifyContent: "space-between", alignItems: "flex-start"}}>
          <div>
            <div style={{fontFamily: sans, fontSize: 13, color: C.brass, letterSpacing: ".15em", textTransform: "uppercase"}}>Workspace / Overview</div>
            <div style={{fontFamily: display, fontSize: 38, color: C.ink, fontWeight: 600, marginTop: 8}}>Good morning, team.</div>
            <div style={{fontFamily: sans, fontSize: 15, color: C.muted, marginTop: 5}}>The whole company, in one clean signal.</div>
          </div>
          <div style={{fontFamily: sans, fontSize: 14, color: C.ink, border: `1px solid ${C.line}`, borderRadius: 999, padding: "12px 18px"}}>12 JUL · LIVE</div>
        </div>

        <div style={{display: "flex", marginTop: 28, border: `1px solid ${C.line}`, borderRadius: 16, overflow: "hidden", background: C.card}}>
          <Kpi label="Active projects" value="12" note="3 ahead of plan" />
          <Kpi label="Pipeline" value="$284K" note="+18.4% this month" />
          <Kpi label="Team pulse" value="92%" note="Healthy capacity" />
          <Kpi label="Open decisions" value="06" note="2 need attention" />
        </div>

        <div style={{display: "grid", gridTemplateColumns: "1.35fr 1fr", gap: 22, marginTop: 22}}>
          <div style={{height: 325, border: `1px solid ${C.line}`, borderRadius: 16, padding: "24px 26px", background: C.card}}>
            <div style={{display: "flex", justifyContent: "space-between"}}>
              <div style={{fontFamily: display, fontSize: 20, fontWeight: 600, color: C.ink}}>Revenue & runway</div>
              <div style={{fontFamily: sans, color: C.muted, fontSize: 13}}>Last 12 weeks</div>
            </div>
            <div style={{height: 220, display: "flex", alignItems: "flex-end", gap: 16, marginTop: 24, borderBottom: `1px solid ${C.line}`}}>
              {barHeights.map((h, i) => {
                const bh = clamp(local, [32 + i * 2, 58 + i * 2], [0, h]);
                return <div key={i} style={{height: bh, flex: 1, borderRadius: "4px 4px 0 0", background: i === 11 ? C.brass : C.brand, opacity: i === 11 ? 1 : 0.9}} />;
              })}
            </div>
          </div>

          <div style={{height: 325, border: `1px solid ${C.line}`, borderRadius: 16, padding: "24px 26px", background: C.card}}>
            <div style={{fontFamily: display, fontSize: 20, fontWeight: 600, color: C.ink}}>Needs attention</div>
            {["Atlas launch", "Orion invoice", "Hire: Product Lead"].map((x, i) => (
              <div key={x} style={{display: "flex", alignItems: "center", gap: 14, padding: "18px 0", borderBottom: i < 2 ? `1px solid ${C.line}` : "none"}}>
                <div style={{width: 9, height: 9, borderRadius: 99, background: i === 0 ? C.warning : i === 1 ? C.brass : C.teal}} />
                <div style={{flex: 1}}>
                  <div style={{fontFamily: sans, fontSize: 15, color: C.ink, fontWeight: 500}}>{x}</div>
                  <div style={{fontFamily: sans, fontSize: 12, color: C.muted, marginTop: 3}}>{i === 0 ? "Decision blocked" : i === 1 ? "6 days overdue" : "Review today"}</div>
                </div>
                <div style={{fontFamily: sans, color: C.muted}}>→</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const PlatformScene = () => {
  const frame = useCurrentFrame();
  const opacity = sceneOpacity(frame, 112, 300, 22);
  return (
    <AbsoluteFill style={{opacity, background: C.abyss2, alignItems: "center", justifyContent: "center"}}>
      <Grid />
      <div style={{position: "absolute", top: 58, left: 82, right: 82, display: "flex", justifyContent: "space-between", alignItems: "center"}}>
        <MicroLabel>One operating system</MicroLabel>
        <div style={{fontFamily: sans, color: "rgba(247,245,239,.62)", fontSize: 18}}>Live company intelligence</div>
      </div>
      <Dashboard />
      <Grain />
    </AbsoluteFill>
  );
};

const ModuleCard = ({
  label,
  title,
  stat,
  delay,
}: {
  label: string;
  title: string;
  stat: string;
  delay: number;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const local = frame - 278;
  const s = spring({frame: local - delay, fps, config: {damping: 18, stiffness: 95}});
  return (
    <div
      style={{
        flex: 1,
        height: 390,
        border: `1px solid ${C.line}`,
        background: C.card,
        borderRadius: 22,
        padding: 32,
        opacity: s,
        transform: `translateY(${(1 - s) * 120}px)`,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <MicroLabel dark={false}>{label}</MicroLabel>
      <div style={{fontFamily: display, fontSize: 34, lineHeight: 1.15, fontWeight: 600, color: C.ink, marginTop: 22, maxWidth: 290}}>{title}</div>
      <div style={{position: "absolute", bottom: 30, left: 32, fontFamily: display, fontSize: 76, fontWeight: 500, color: C.brand, letterSpacing: "-0.05em"}}>{stat}</div>
      <div style={{position: "absolute", width: 160, height: 160, borderRadius: 999, border: `1px solid ${C.line}`, right: -45, bottom: -48}} />
      <div style={{position: "absolute", width: 92, height: 92, borderRadius: 999, background: C.brass, opacity: 0.1, right: -16, bottom: -18}} />
    </div>
  );
};

const ModulesScene = () => {
  const frame = useCurrentFrame();
  const opacity = sceneOpacity(frame, 270, 432, 20);
  const heading = clamp(frame, [280, 315], [55, 0]);
  return (
    <AbsoluteFill style={{opacity, background: C.paper, color: C.ink, padding: "74px 90px"}}>
      <Grid dark={false} />
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "flex-end", transform: `translateY(${heading}px)`}}>
        <div>
          <MicroLabel dark={false}>The whole company, connected</MicroLabel>
          <div style={{fontFamily: display, fontSize: 66, fontWeight: 600, lineHeight: 1.02, letterSpacing: "-0.04em", marginTop: 18}}>
            Less switching.
            <br />
            <span style={{color: C.brass}}>More momentum.</span>
          </div>
        </div>
        <div style={{fontFamily: sans, color: C.muted, fontSize: 20, lineHeight: 1.5, width: 470, paddingBottom: 6}}>
          Work, money, relationships and decisions—finally sharing the same context.
        </div>
      </div>
      <div style={{display: "flex", gap: 20, marginTop: 62}}>
        <ModuleCard label="Delivery" title="Projects that move with the team." stat="12" delay={0} />
        <ModuleCard label="Commercial" title="Clients and finance in one view." stat="$284K" delay={6} />
        <ModuleCard label="People" title="Capacity without the guesswork." stat="92%" delay={12} />
        <ModuleCard label="Collaboration" title="Realtime, without the noise." stat="LIVE" delay={18} />
      </div>
    </AbsoluteFill>
  );
};

const AiScene = () => {
  const frame = useCurrentFrame();
  const opacity = sceneOpacity(frame, 410, 588, 20);
  const local = frame - 420;
  const panel = clamp(local, [0, 35], [0.92, 1]);
  const response = clamp(local, [58, 82], [40, 0]);
  const responseOpacity = clamp(local, [54, 76], [0, 1]);
  const scan = clamp(local, [22, 100], [0, 1]);
  return (
    <AbsoluteFill style={{opacity, background: C.abyss, color: C.paper, padding: "72px 90px"}}>
      <Grid />
      <div style={{display: "flex", height: "100%", alignItems: "center", gap: 92}}>
        <div style={{width: 660}}>
          <MicroLabel>Meet your AI operator</MicroLabel>
          <div style={{fontFamily: display, fontSize: 78, fontWeight: 600, lineHeight: 1.03, letterSpacing: "-0.045em", marginTop: 22}}>
            Ask once.
            <br />
            <span style={{color: C.brass}}>Act everywhere.</span>
          </div>
          <div style={{fontFamily: sans, fontSize: 22, color: "rgba(247,245,239,.64)", lineHeight: 1.55, width: 560, marginTop: 30}}>
            Natural-language access to the company—with sensitive actions kept approval-gated.
          </div>
          <div style={{display: "flex", gap: 14, marginTop: 36}}>
            <div style={{border: "1px solid rgba(247,245,239,.16)", borderRadius: 999, padding: "12px 18px", fontFamily: sans, fontSize: 15}}>96 tools</div>
            <div style={{border: "1px solid rgba(247,245,239,.16)", borderRadius: 999, padding: "12px 18px", fontFamily: sans, fontSize: 15}}>Human approval</div>
            <div style={{border: "1px solid rgba(247,245,239,.16)", borderRadius: 999, padding: "12px 18px", fontFamily: sans, fontSize: 15}}>Shared context</div>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            maxWidth: 940,
            height: 760,
            border: "1px solid rgba(247,245,239,.18)",
            borderRadius: 30,
            background: "rgba(12,46,44,.88)",
            boxShadow: "0 60px 160px rgba(0,0,0,.28)",
            overflow: "hidden",
            transform: `scale(${panel})`,
          }}
        >
          <div style={{height: 76, borderBottom: "1px solid rgba(247,245,239,.12)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 28px"}}>
            <div style={{display: "flex", alignItems: "center", gap: 13}}>
              <div style={{width: 34, height: 34, borderRadius: 10, background: C.brass, display: "grid", placeItems: "center", color: C.abyss, fontFamily: display, fontWeight: 600}}>D</div>
              <div style={{fontFamily: display, fontSize: 18, fontWeight: 600}}>DevFathom Operator</div>
            </div>
            <div style={{fontFamily: sans, fontSize: 13, color: "rgba(247,245,239,.55)"}}>GEMINI · SECURE</div>
          </div>
          <div style={{padding: 34}}>
            <div style={{fontFamily: sans, fontSize: 14, color: "rgba(247,245,239,.5)", marginBottom: 12}}>YOU</div>
            <div style={{fontFamily: sans, fontSize: 27, lineHeight: 1.4, color: C.paper, maxWidth: 740}}>
              Show me what needs attention before Friday.
              <span style={{display: "inline-block", width: 2, height: 28, background: C.brass, marginLeft: 7, transform: `scaleY(${Math.sin(frame / 5) > 0 ? 1 : 0})`}} />
            </div>
            <div style={{height: 2, background: "rgba(247,245,239,.08)", margin: "31px 0", overflow: "hidden"}}>
              <div style={{height: "100%", width: `${scan * 100}%`, background: C.brass}} />
            </div>

            <div style={{opacity: responseOpacity, transform: `translateY(${response}px)`}}>
              <div style={{fontFamily: sans, fontSize: 14, color: C.brass, marginBottom: 15}}>OPERATOR</div>
              <div style={{fontFamily: display, fontSize: 31, lineHeight: 1.35, fontWeight: 500}}>Three things need your attention.</div>
              {[
                ["01", "Atlas launch", "Blocked by one client decision", "Project"],
                ["02", "Orion invoice", "$18,400 · 6 days overdue", "Finance"],
                ["03", "Product Lead", "Final interview scorecard ready", "People"],
              ].map(([n, title, note, type], i) => (
                <div key={title} style={{display: "grid", gridTemplateColumns: "42px 1fr auto", alignItems: "center", gap: 14, padding: "20px 0", borderBottom: "1px solid rgba(247,245,239,.11)"}}>
                  <div style={{fontFamily: sans, color: C.brass, fontSize: 13}}>{n}</div>
                  <div>
                    <div style={{fontFamily: sans, color: C.paper, fontSize: 18, fontWeight: 500}}>{title}</div>
                    <div style={{fontFamily: sans, color: "rgba(247,245,239,.52)", fontSize: 14, marginTop: 3}}>{note}</div>
                  </div>
                  <div style={{fontFamily: sans, color: "rgba(247,245,239,.54)", fontSize: 12, border: "1px solid rgba(247,245,239,.14)", padding: "7px 10px", borderRadius: 999}}>{type}</div>
                </div>
              ))}
              <div style={{display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 24}}>
                <div style={{fontFamily: sans, color: C.paper, border: "1px solid rgba(247,245,239,.18)", borderRadius: 11, padding: "12px 17px", fontSize: 14}}>Review details</div>
                <div style={{fontFamily: sans, color: C.abyss, background: C.brass, borderRadius: 11, padding: "12px 17px", fontSize: 14, fontWeight: 600}}>Prepare actions</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <Grain />
    </AbsoluteFill>
  );
};

const Outro = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const wipe = clamp(frame, [552, 584], [0, 1]);
  const logo = spring({frame: frame - 574, fps, config: {damping: 18, stiffness: 80}});
  const rule = clamp(frame, [590, 655], [0, 1]);
  return (
    <AbsoluteFill
      style={{
        background: C.paper,
        color: C.ink,
        alignItems: "center",
        justifyContent: "center",
        clipPath: `inset(${(1 - wipe) * 100}% 0 0 0)`,
      }}
    >
      <Grid dark={false} />
      <div style={{display: "flex", alignItems: "center", gap: 22, transform: `scale(${0.82 + logo * 0.18})`, opacity: logo}}>
        <Mark size={112} />
        <div style={{fontFamily: display, fontSize: 79, fontWeight: 600, letterSpacing: "-0.045em", color: C.abyss2}}>DevFathom</div>
      </div>
      <div style={{fontFamily: sans, fontSize: 22, letterSpacing: ".11em", textTransform: "uppercase", color: C.brass, marginTop: 28, opacity: clamp(frame, [602, 632], [0, 1])}}>The company hub</div>
      <div style={{width: 610, height: 1, background: C.line, margin: "42px 0 34px", overflow: "hidden"}}>
        <div style={{height: "100%", width: `${rule * 100}%`, background: C.brand}} />
      </div>
      <div style={{fontFamily: display, fontSize: 48, fontWeight: 500, letterSpacing: "-0.025em", opacity: clamp(frame, [625, 658], [0, 1])}}>
        Depth in everything we build.
      </div>
      <div style={{position: "absolute", bottom: 50, left: 70, right: 70, display: "flex", justifyContent: "space-between", color: C.muted, fontFamily: sans, fontSize: 14, letterSpacing: ".12em", textTransform: "uppercase"}}>
        <div>One workspace</div>
        <div>Every moving part</div>
      </div>
    </AbsoluteFill>
  );
};

export const DevFathomFilm: React.FC = () => {
  return (
    <AbsoluteFill style={{backgroundColor: C.abyss}}>
      <Audio src={staticFile("soundtrack.wav")} volume={0.68} />
      <Sequence from={0} durationInFrames={148} premountFor={30}>
        <Intro />
      </Sequence>
      <Sequence from={0} durationInFrames={310} premountFor={30}>
        <PlatformScene />
      </Sequence>
      <Sequence from={0} durationInFrames={442} premountFor={30}>
        <ModulesScene />
      </Sequence>
      <Sequence from={0} durationInFrames={600} premountFor={30}>
        <AiScene />
      </Sequence>
      <Sequence from={0} durationInFrames={720} premountFor={30}>
        <Outro />
      </Sequence>
    </AbsoluteFill>
  );
};
