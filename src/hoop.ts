// The period for the constant pulsing when the agent is on.
const PULSE_PERIOD_SECONDS = 3;
// How much larger/smaller than "normal" size (as a percentage) the pulse gets.
const PULSE_SIZE_MULTIPLIER = 1.02;
// The speed at which the colors move along their lines. A "period" is the time
// to return to their original position. Divide by the current state's time
// speed for actual rotation period.
const AVERAGE_ROTATION_PERIOD_SECONDS = 6;
// the "base" rocking period. Divide by the current state's time speed for
// actual rocking period.
const ROCKING_PERIOD_SECONDS = 3;
// Total transition time when switching max rocking angle.
const ROCKING_TRANSITION_TIME_MS = 1000;
// How far down to deflate (in radii) in the maximum state.
const DEFLATE_PULL = 2;
// Total transition time when deflating.
const DEFLATE_TRANSITION_TIME_MS = 1000;
// Total transition time when inflating.
const INFLATE_TRANSITION_TIME_MS = 300;
// How much to increase/decrease the circle size when "chattering".
const CHATTER_SIZE_MULTIPLIER = 1.15;
// How many frames to use when calculating the chatter effect for a line.
// Larger windows have a smoothing effect.
const CHATTER_WINDOW_SIZE = 3;
// When "chattering", the number of frames it takes for one line to catch up to
// the next.
const CHATTER_FRAME_LAG = 5;
// Display circles at arc endpoints, bottom of animation, and center.
const DEBUG = false;

interface Point {
  x: number;
  y: number;
}

interface ColorStop {
  pct: number;
  color: string;
}

type NonEmptyArray<T> = [T, ...T[]];

interface LineConfig {
  segments: NonEmptyArray<ColorStop>;
  startAngle: number;
  speedMultiplier: number;
  centerOffset: Point;
  radiusOffset: number;
  width: number;
}

interface Deflation {
  angle: number;
  depth: number;
}

interface Shape {
  generation: number;
  time: number;
  // multiplier that controls the progress of time
  speed: number;
  deflation: number;
  rockingAngle: number;
  agentNoise: number[];
  userNoise: number[];
  end: boolean;
}

// eslint-disable-next-line import/prefer-default-export
export enum VoiceBotStatus {
  Active = "active",
  Sleeping = "sleeping",
  NotStarted = "not-started",
}

type Context = CanvasRenderingContext2D;

const pi = (n: number): number => Math.PI * n;

const coordsFrom = (
  { x, y }: Point,
  distance: number,
  angle: number,
): Point => ({
  x: x + distance * Math.cos(angle),
  y: y + distance * Math.sin(angle),
});

const bezier = (ctx: Context, cp1: Point, cp2: Point, end: Point): void => {
  ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
};

const circle = (ctx: Context, center: Point, r: number): void => {
  ctx.ellipse(center.x, center.y, r, r, 0, 0, pi(2));
};

const lerp = (start: number, stop: number, amt: number): number =>
  amt * (stop - start) + start;

const clamp = (
  { low, high }: { low: number; high: number },
  val: number,
): number => Math.min(high, Math.max(val, low));

/**
 * https://easings.net/#easeInOutQuad
 */
const easeInOutQuad = (x: number): number =>
  x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;

const getCenter = (ctx: Context): Point => {
  const { width, height } = ctx.canvas.getBoundingClientRect();

  return {
    x: width / 2,
    y: height / 2,
  };
};

const crescent = (
  ctx: Context,
  offset: Point,
  radius: number,
  deflation: Deflation,
  strokeStyle: CanvasGradient,
): void => {
  /**
   * to approximate a circle segment, the two control points of a bezier curve
   * need to be at a specific distance, represented by
   *
   * circleRadius * (4 / 3) * Math.tan(Math.PI / (2 * n))
   *
   * where n is # of segments in a full circle. the angle for that distance is
   * simply "tangential to the arc at the closest endpoint"
   */
  const bezierDistance = radius * (4 / 3) * Math.tan(pi(1 / 8));

  const trueCenter = getCenter(ctx);
  const center = {
    x: trueCenter.x * (1 + offset.x),
    y: trueCenter.y * (1 + offset.y),
  };
  ctx.strokeStyle = strokeStyle;
  ctx.beginPath();

  // the "true circle" part
  const arcStart = deflation.angle + pi(1 / 2);
  const arcEnd = deflation.angle + pi(3 / 2);
  ctx.arc(center.x, center.y, radius, arcStart, arcEnd, false);

  // the "deflatable" part. two bezier curves each approximating a quarter-circle
  const start = coordsFrom(center, radius, arcEnd);
  const angleTowardsXAxis = pi(3 / 2) - deflation.angle;
  const distanceDownToXAxis = Math.cos(angleTowardsXAxis) * radius;
  const mid = coordsFrom(
    coordsFrom(center, radius, deflation.angle), // where the point would be with no deflation
    distanceDownToXAxis * deflation.depth * DEFLATE_PULL,
    pi(1 / 2),
  );

  const end = coordsFrom(center, radius, arcStart);

  /**
   * The way to find a control point is to take that distance from the equation
   * above, and move "tangential to the circle at the closer endpoint"
   */
  const bez1 = {
    cp1: coordsFrom(start, bezierDistance, arcEnd + pi(1 / 2)),
    cp2: coordsFrom(mid, bezierDistance, deflation.angle + pi(3 / 2)),
  };
  const bez2 = {
    cp1: coordsFrom(mid, bezierDistance, deflation.angle + pi(1 / 2)),
    cp2: coordsFrom(end, bezierDistance, arcStart + pi(3 / 2)),
  };

  bezier(ctx, bez1.cp1, bez1.cp2, mid);
  bezier(ctx, bez2.cp1, bez2.cp2, end);
  ctx.stroke();
  if (DEBUG) {
    ctx.strokeStyle = "red";
    ctx.beginPath();
    circle(ctx, center, 5);
    ctx.stroke();
    ctx.beginPath();
    circle(ctx, coordsFrom(center, radius, arcStart), 5);
    ctx.stroke();
    ctx.beginPath();
    circle(ctx, coordsFrom(center, radius, arcEnd), 5);
    ctx.stroke();
    ctx.beginPath();
    circle(ctx, coordsFrom(center, radius, (arcStart + arcEnd) / 2), 5);
    ctx.stroke();
    ctx.beginPath();
    circle(ctx, mid, 5);
    ctx.stroke();
  }
};

const makeGradient = (
  ctx: Context,
  offset: Point,
  angle: number,
  parts: ColorStop[],
): CanvasGradient => {
  const center = getCenter(ctx);
  const x1 = center.x * (1 - Math.cos(angle) + offset.x);
  const y1 = center.y * (1 - Math.sin(angle) + offset.y);
  const x2 = center.x * (1 + Math.cos(angle) + offset.x);
  const y2 = center.y * (1 + Math.sin(angle) + offset.y);
  const g = ctx.createLinearGradient(x1, y1, x2, y2);
  parts.forEach(({ pct, color }: ColorStop) => {
    g.addColorStop(pct, color);
  });

  return g;
};

enum Color {
  springGreen = "#13ef93cc",
  magenta = "#ee028ccc",
  lightPurple = "#ae63f9cc",
  lightBlue = "#14a9fbcc",
  green = "#a1f9d4cc",
  darkBlue = "#4b3cffcc",
  purple = "#dd0070cc",
  transparent = "transparent",
}

enum Attributes {
  orbState = "orb-state",
  agentVolume = "agent-volume",
  userVolume = "user-volume",
}

/**
 * These were picked from a bakeoff of some random color configs
 * and then added onto with the help of our automation overlords
 */
const lines: LineConfig[] = [
  {
    segments: [
      { pct: 0.42, color: Color.transparent },
      { pct: 0.61, color: Color.magenta },
    ],
    startAngle: 3.52,
    speedMultiplier: 1.21,
    centerOffset: {
      x: 0.01,
      y: -0.01,
    },
    radiusOffset: 0.02,
    width: 3.38,
  },
  {
    segments: [
      { pct: 0.28, color: Color.springGreen },
      { pct: 0.62, color: Color.magenta },
      { pct: 0.8, color: Color.transparent },
    ],
    startAngle: 1.59,
    speedMultiplier: 0.64,
    centerOffset: {
      x: -0.03,
      y: -0.01,
    },
    radiusOffset: 0.05,
    width: 2.39,
  },
  {
    segments: [
      { pct: 0.1, color: Color.transparent },
      { pct: 0.31, color: Color.green },
      { pct: 0.45, color: Color.lightBlue },
      { pct: 0.66, color: Color.lightPurple },
    ],
    startAngle: 2.86,
    speedMultiplier: 0.94,
    centerOffset: {
      x: 0.02,
      y: 0.02,
    },
    radiusOffset: -0.06,
    width: 2.64,
  },
  {
    segments: [
      { pct: 0.1, color: Color.lightPurple },
      { pct: 0.5, color: Color.transparent },
      { pct: 0.9, color: Color.green },
    ],
    startAngle: 5.67,
    speedMultiplier: 1.3,
    centerOffset: {
      x: -0.01,
      y: 0.01,
    },
    radiusOffset: 0.04,
    width: 2.95,
  },
];
const LINE_COUNT = lines.length;

const radiusOscillation = (shape: Shape): number =>
  1 +
  (PULSE_SIZE_MULTIPLIER - 1) *
    Math.sin((shape.time * pi(1)) / PULSE_PERIOD_SECONDS / 1000) *
    lerp(1, 0, shape.deflation);

const rollingAverage = (noise: number[], start: number): number => {
  const noiseWindow = noise.slice(start, start + CHATTER_WINDOW_SIZE);
  return noiseWindow.reduce((a, b) => a + b) / noiseWindow.length;
};

const speechSimulation = (shape: Shape, start: number): number =>
  lerp(1, CHATTER_SIZE_MULTIPLIER, rollingAverage(shape.agentNoise, start));

const listeningSimulation = (shape: Shape, start: number): number =>
  lerp(1, 1 / CHATTER_SIZE_MULTIPLIER, rollingAverage(shape.userNoise, start));

const draw = (ctx: Context, shape: Shape, last: number, now: number): void => {
  if (shape.end) return;
  // eslint-disable-next-line no-param-reassign
  shape.time += (now - last) * lerp(1, shape.speed, shape.deflation);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.filter = "saturate(100%)";

  const center = getCenter(ctx);
  const maxRadius = Math.min(center.x, center.y);

  lines.forEach((line, i) => {
    ctx.lineWidth = line.width;
    ctx.shadowColor = line.segments[0].color;
    ctx.shadowBlur = line.width * 1.1;
    const radius =
      maxRadius *
      0.8 *
      speechSimulation(shape, i * CHATTER_FRAME_LAG) *
      listeningSimulation(shape, i * CHATTER_FRAME_LAG) *
      radiusOscillation(shape);
    const gradient = makeGradient(
      ctx,
      line.centerOffset,
      line.startAngle +
        ((shape.time * pi(1)) / 1000 / AVERAGE_ROTATION_PERIOD_SECONDS) *
          line.speedMultiplier,
      line.segments,
    );
    crescent(
      ctx,
      line.centerOffset,
      radius + line.radiusOffset * radius,
      {
        depth: easeInOutQuad(shape.deflation),
        angle:
          pi(3 / 2) +
          Math.sin((shape.time * pi(2)) / ROCKING_PERIOD_SECONDS / 1000) *
            shape.rockingAngle,
      },
      gradient,
    );
  });

  requestAnimationFrame((t) => {
    draw(ctx, shape, now, t);
  });
};

// How completely to deflate.
const deflationDepth = (orbState: string): number => {
  switch (orbState) {
    case VoiceBotStatus.Active:
      return 0;
    case VoiceBotStatus.Sleeping:
      return 0.65;
    case VoiceBotStatus.NotStarted:
      return 1;
    default:
      return 0;
  }
};

// How far (in radians) to tip in each direction.
const rockingAngle = (orbState: string): number => {
  switch (orbState) {
    case VoiceBotStatus.Active:
      return pi(1 / 15);
    case VoiceBotStatus.Sleeping:
      return pi(1 / 15);
    case VoiceBotStatus.NotStarted:
      return pi(1 / 2);
    default:
      return pi(1 / 15);
  }
};

// How quickly time moves forward. 1 means "1 second per real second", 0.5 means "1 second per 2 real seconds".
const speedOf = (orbState: string): number => {
  switch (orbState) {
    case VoiceBotStatus.Active:
      return 1;
    case VoiceBotStatus.Sleeping:
      return 0.5;
    case VoiceBotStatus.NotStarted:
      return 0.2;
    default:
      return 1;
  }
};

const transition = (
  generation: number,
  start: { time: number; deflation: number; rockingAngle: number },
  end: { deflation: number; rockingAngle: number },
  shape: Shape,
  now: number = start.time,
) => {
  // drop this transition if a newer one has been produced
  if (shape.generation > generation) return;

  if (end.deflation !== shape.deflation) {
    const transitionTime =
      end.deflation > start.deflation
        ? DEFLATE_TRANSITION_TIME_MS
        : INFLATE_TRANSITION_TIME_MS;
    const progress = easeInOutQuad(
      clamp({ low: 0, high: 1 }, (now - start.time) / transitionTime),
    );

    // eslint-disable-next-line no-param-reassign
    shape.deflation =
      progress === 1
        ? end.deflation
        : lerp(start.deflation, end.deflation, progress);
  }

  if (end.rockingAngle !== shape.rockingAngle) {
    const progress = easeInOutQuad(
      clamp(
        { low: 0, high: 1 },
        (now - start.time) / ROCKING_TRANSITION_TIME_MS,
      ),
    );

    // eslint-disable-next-line no-param-reassign
    shape.rockingAngle =
      progress === 1
        ? end.rockingAngle
        : lerp(start.rockingAngle, end.rockingAngle, progress);
  }

  if (
    shape.deflation !== end.deflation ||
    shape.rockingAngle !== end.rockingAngle
  ) {
    requestAnimationFrame((ts) => {
      transition(generation, start, end, shape, ts);
    });
  }
};

customElements.define(
  "deepgram-hoop",
  class extends HTMLElement {
    canvas: HTMLCanvasElement;

    shape: Shape;

    constructor() {
      super();
      this.canvas = document.createElement("canvas");
      this.shape = {
        generation: 0,
        time: 0,
        speed: speedOf(VoiceBotStatus.NotStarted),
        rockingAngle: rockingAngle(VoiceBotStatus.NotStarted),
        deflation: deflationDepth(VoiceBotStatus.NotStarted),
        agentNoise: Array(
          LINE_COUNT * CHATTER_FRAME_LAG + CHATTER_WINDOW_SIZE,
        ).fill(0),
        userNoise: Array(
          LINE_COUNT * CHATTER_FRAME_LAG + CHATTER_WINDOW_SIZE,
        ).fill(0),
        end: false,
      };
    }

    connectedCallback() {
      const orbState =
        this.getAttribute(Attributes.orbState) || VoiceBotStatus.NotStarted;
      const agentVolume =
        Number(this.getAttribute(Attributes.agentVolume)) || 0;
      const userVolume = Number(this.getAttribute(Attributes.userVolume)) || 0;
      this.canvas.width = Number(this.getAttribute("width")) || 0;
      this.canvas.height = Number(this.getAttribute("height")) || 0;

      this.appendChild(this.canvas);

      this.shape = {
        generation: 0,
        time: 0,
        speed: speedOf(orbState),
        rockingAngle: rockingAngle(orbState),
        deflation: deflationDepth(orbState),
        agentNoise: Array(
          LINE_COUNT * CHATTER_FRAME_LAG + CHATTER_WINDOW_SIZE,
        ).fill(agentVolume),
        userNoise: Array(
          LINE_COUNT * CHATTER_FRAME_LAG + CHATTER_WINDOW_SIZE,
        ).fill(userVolume),
        end: false,
      };

      const ctx = this.canvas.getContext("2d");
      if (ctx) {
        const now = performance.now();
        requestAnimationFrame((t) => {
          if (this.shape) draw(ctx, this.shape, now, t);
        });
      }
    }

    disconnectedCallback() {
      this.shape.end = true;
    }

    static get observedAttributes() {
      return Object.values(Attributes);
    }

    attributeChangedCallback(name: string, _: string, newValue: string) {
      switch (name) {
        case Attributes.orbState:
          this.shape.generation += 1;
          this.shape.speed = speedOf(newValue);
          requestAnimationFrame((time) => {
            const start = {
              rockingAngle: this.shape.rockingAngle,
              deflation: this.shape.deflation,
              time,
            };
            const end = {
              rockingAngle: rockingAngle(newValue),
              deflation: deflationDepth(newValue),
            };
            transition(this.shape.generation, start, end, this.shape);
          });
          break;
        case Attributes.agentVolume:
          if (Number.isNaN(Number(newValue))) break;
          this.shape.agentNoise.shift();
          this.shape.agentNoise.push(Number(newValue));
          break;
        case Attributes.userVolume:
          if (Number.isNaN(Number(newValue))) break;
          this.shape.userNoise.shift();
          this.shape.userNoise.push(Number(newValue));
          break;
        default:
          break;
      }
    }
  },
);
