import Result, { match } from "true-myth/result";
import debounce, { type DebouncedFunction } from "debounce";
import { VoiceBotStatus } from "./hal";

enum AgentEvent {
  NO_KEY = "no key",
  NO_URL = "no url",
  NO_CONFIG = "no config",
  EMPTY_AUDIO = "empty audio",
  SOCKET_OPEN = "socket open",
  SOCKET_CLOSE = "socket close",
  CONNECTION_TIMEOUT = "connection timeout",
  /** Something went wrong in a way we don't expect the user to recover */
  FAILED_SETUP = "failed setup",
  FAILED_TO_CONNECT_USER_MEDIA = "failed to connect user media",
  UNKNOWN_MESSAGE = "unknown message",
  STRUCTURED_MESSAGE = "structured message",
  CLIENT_MESSAGE = "client message",
}

type AgentEventDetail = { variant: AgentEvent; detail?: object };

enum MessageType {
  /** first detection of user speech */
  UserStartedSpeaking = "UserStartedSpeaking",
  /** EOT model decides the user's ended their turn */
  EndOfThought = "EndOfThought",
  /** Agent audio starts coming across the socket */
  AgentStartedSpeaking = "AgentStartedSpeaking",
  /** All agent audio is sent (different from TTS being complete!) */
  AgentAudioDone = "AgentAudioDone",
}

enum Sender {
  User,
  Agent,
}

const normalizeVolume = (
  analyser: AnalyserNode,
  dataArray: Uint8Array,
  normalizationFactor: number,
): number => {
  analyser.getByteFrequencyData(dataArray);
  const sum = dataArray.reduce((acc, val) => acc + val, 0);
  const average = sum / dataArray.length;
  return Math.min(average / normalizationFactor, 1);
};

const convertFloat32ToInt16 = (buffer: Float32Array): ArrayBuffer => {
  const buf = new Int16Array(buffer.length);
  for (let l = 0; l < buffer.length; l += 1) {
    buf[l] = Math.min(1, buffer[l] ?? 0) * 0x7fff;
  }
  return buf.buffer;
};

const sendMicTo =
  (socket: WebSocket) =>
  (event: AudioProcessingEvent): void => {
    const inputData = event.inputBuffer.getChannelData(0);
    const audioDataToSend = convertFloat32ToInt16(inputData);
    if (socket.readyState === WebSocket.OPEN) socket.send(audioDataToSend);
  };

const createAnalyser = (context: AudioContext): AnalyserNode => {
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.96;
  return analyser;
};

const tryDisconnect = (source?: AudioNode | null, destination?: AudioNode) => {
  if (!source || !destination) return;
  try {
    source.disconnect(destination);
  } catch {}
};

interface UserMediaNodes {
  microphone: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  analyser: AnalyserNode;
}

const getNodes = async (
  context: AudioContext,
): Promise<Result<UserMediaNodes, AgentEventDetail>> =>
  navigator.mediaDevices
    .getUserMedia({
      // these are constraints that browsers are free to ignore
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false,
      },
    })
    .then((stream) =>
      Result.ok({
        microphone: context.createMediaStreamSource(stream),
        // TODO: fancy folks would be using an AudioWorklet here!
        processor: context.createScriptProcessor(4096, 1, 1),
        analyser: createAnalyser(context),
      }),
    )
    .catch(() =>
      Result.err({ variant: AgentEvent.FAILED_TO_CONNECT_USER_MEDIA }),
    );

const getConfigString = (
  agentConfigString: string,
): Result<string, AgentEventDetail> => {
  try {
    const agentConfig = JSON.parse(agentConfigString);
    return Result.ok(JSON.stringify(agentConfig));
  } catch {
    return Result.err({ variant: AgentEvent.FAILED_SETUP });
  }
};

const sendVolumeUpdates = (
  analyser: AnalyserNode,
  hal: HTMLElement,
  attributeName: string,
) => {
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const getVolume = () => {
    if (hal.getAttribute("orb-state") === VoiceBotStatus.Active) {
      hal.setAttribute(
        attributeName,
        normalizeVolume(analyser, dataArray, 48).toString(),
      );
    }
    if (analyser.context.state === "running") requestAnimationFrame(getVolume);
  };
  getVolume();
};

const AudioContextClass =
  window.AudioContext ||
  (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

const openWebSocket = async (
  url: string,
  apiKey: string,
): Promise<Result<WebSocket, AgentEventDetail>> => {
  try {
    const socket = new WebSocket(url, ["token", apiKey]);
    socket.binaryType = "arraybuffer";

    // The following promise can resolve in one of several different ways depending on what happens
    // with the socket connection. Whichever event happens first wins; the other resolves are then
    // noöps.
    return await new Promise<Result<WebSocket, AgentEventDetail>>((resolve) => {
      socket.addEventListener("open", () => resolve(Result.ok(socket)));

      // If the server immediately terminates the connection (e.g. because the user has insufficient
      // funds), we'll receive the "close" event without first receiving an "open" event.
      socket.addEventListener("close", (event) =>
        resolve(
          Result.err({ variant: AgentEvent.SOCKET_CLOSE, detail: event }),
        ),
      );

      // If the socket fails to connect in a reasonable amount of time, resolve with an error;
      // the socket gets cleaned up when the calling code calls this.disconnect()
      setTimeout(
        () => resolve(Result.err({ variant: AgentEvent.CONNECTION_TIMEOUT })),
        10000,
      );
    });
  } catch {
    return Result.err({ variant: AgentEvent.FAILED_SETUP });
  }
};

const pairResults = <A, B, E>(
  r1: Result<A, E>,
  r2: Result<B, E>,
): Result<[A, B], E> => r1.andThen((ok1) => r2.map((ok2) => [ok1, ok2]));

enum Attributes {
  url = "url",
  width = "width",
  height = "height",
}

enum ObservedAttributes {
  config = "config",
  idleTimeoutMs = "idle-timeout-ms",
}

customElements.define(
  "deepgram-agent",
  class AgentElement extends HTMLElement {
    private socket: WebSocket | null;

    private microphone: MediaStreamAudioSourceNode | null;
    private processor: ScriptProcessorNode | undefined;
    private scheduledPlaybackSources: Set<AudioBufferSourceNode>;
    private startTime: number;
    private ttsAnalyser: AnalyserNode | undefined;
    private ttsContext: AudioContext | undefined;
    private micAnalyser: AnalyserNode | undefined;
    private micContext: AudioContext | undefined;

    private hal: HTMLElement;

    apiKey: string | undefined;

    private activeSender: Sender | null;

    private startIdleTimeout: DebouncedFunction<() => void>;

    constructor() {
      super();
      this.socket = null;
      this.microphone = null;

      // unlike the socket and the mic setup, we can leave the tts context
      // sitting around
      this.scheduledPlaybackSources = new Set();
      this.startTime = -1;
      this.activeSender = null;
      this.hal = document.createElement("deepgram-hal");

      try {
        if (!AudioContextClass) {
          throw new Error("Web Audio API is not supported in this browser");
        }
        this.ttsContext = new AudioContextClass({
          latencyHint: "interactive",
          // might be nice to delegate to the machine here, but the /agent API
          // doesn't seem to tolerate a 44.1k sample rate for output
          sampleRate: 48000,
        });
        this.ttsAnalyser = createAnalyser(this.ttsContext);
        // this.ttsAnalyser.connect(this.ttsContext.destination);

        this.micContext = new AudioContextClass();

        sendVolumeUpdates(this.ttsAnalyser, this.hal, "agent-volume");
      } catch {
        this.dispatch(AgentEvent.FAILED_SETUP);
      }

      this.startIdleTimeout = debounce(() => {}, 0);
    }

    static get observedAttributes() {
      return Object.values(ObservedAttributes);
    }

    private replaceIdleTimeout(timeoutString: string | null) {
      if (Number.isNaN(Number(timeoutString))) return;
      this.startIdleTimeout.clear();
      this.startIdleTimeout = debounce(
        () => this.disconnect("idle timeout"),
        Number(timeoutString),
      );
    }

    private dispatch(variant: AgentEvent, detail?: object) {
      this.dispatchEvent(
        detail
          ? new CustomEvent(variant, { detail })
          : new CustomEvent(variant),
      );
    }

    sendClientMessage(message: ArrayBuffer | string): void {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(message);
        // Would consumers like us to emit something when audio is sent?
        if (typeof message === "string") {
          this.dispatch(AgentEvent.CLIENT_MESSAGE, JSON.parse(message));
        }
      }
    }

    private connectNodes({
      microphone,
      processor,
      analyser,
    }: UserMediaNodes): Result<UserMediaNodes, AgentEventDetail> {
      this.microphone = microphone;
      this.processor = processor;
      this.micAnalyser = analyser;

      if (!this.micContext || !this.ttsAnalyser || !this.ttsContext) {
        return Result.err({ variant: AgentEvent.FAILED_SETUP });
      }
      this.microphone.connect(this.micAnalyser);
      this.microphone.connect(this.processor);
      this.processor.connect(this.micContext.destination);
      this.ttsAnalyser.connect(this.ttsContext.destination);
      sendVolumeUpdates(this.micAnalyser, this.hal, "user-volume");
      sendVolumeUpdates(this.ttsAnalyser, this.hal, "agent-volume");

      return Result.ok({ microphone, processor, analyser });
    }

    private disconnectNodes() {
      tryDisconnect(this.microphone, this.micAnalyser);
      tryDisconnect(this.microphone, this.processor);
      tryDisconnect(this.processor, this.micContext?.destination);
      tryDisconnect(this.ttsAnalyser, this.ttsContext?.destination);
    }

    private async suspendContext() {
      if (this.micContext) await this.micContext.suspend();
      if (this.ttsContext) await this.ttsContext.suspend();
    }

    private async resumeContext() {
      if (this.micContext) await this.micContext.resume();
      if (this.ttsContext) await this.ttsContext.resume();
    }

    private async closeContext() {
      if (this.micContext) await this.micContext.close();
      if (this.ttsContext) await this.ttsContext.close();
    }

    private playAudio(data: ArrayBuffer) {
      if (!this.ttsAnalyser) return;
      const { context } = this.ttsAnalyser;

      const audioDataView = new Int16Array(data);
      if (audioDataView.length === 0) {
        this.dispatch(AgentEvent.EMPTY_AUDIO);
        return;
      }

      const buffer = context.createBuffer(1, audioDataView.length, 48000);
      const channelData = buffer.getChannelData(0);

      // Convert linear16 PCM to float [-1, 1]
      audioDataView.forEach((value, index) => {
        channelData[index] = value / 32768;
      });

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.ttsAnalyser);

      const { currentTime } = context;
      if (this.startTime < currentTime) {
        this.startTime = currentTime;
      }

      source.addEventListener("ended", () => {
        this.scheduledPlaybackSources.delete(source);
        this.checkAndHandleTtsPlaybackCompleted();
      });
      source.start(this.startTime);
      this.startTime += buffer.duration;

      this.scheduledPlaybackSources.add(source);
    }

    private checkAndHandleTtsPlaybackCompleted() {
      if (
        this.scheduledPlaybackSources.size === 0 &&
        this.activeSender === null
      ) {
        this.startIdleTimeout();
      }
    }

    private clearActiveSenderIf(activeSender: Sender) {
      if (this.activeSender === activeSender) this.activeSender = null;
    }

    private handleSocketMessage(message: MessageEvent) {
      if (message.data instanceof ArrayBuffer) {
        this.playAudio(message.data);
      } else {
        try {
          const data = JSON.parse(message.data);

          switch (data.type) {
            case MessageType.UserStartedSpeaking:
              this.activeSender = Sender.User;
              this.stopTts();
              this.startIdleTimeout.clear();
              break;
            case MessageType.EndOfThought:
              this.clearActiveSenderIf(Sender.User);
              break;
            case MessageType.AgentStartedSpeaking:
              this.activeSender = Sender.Agent;
              break;
            case MessageType.AgentAudioDone:
              this.clearActiveSenderIf(Sender.Agent);
              this.checkAndHandleTtsPlaybackCompleted();
              break;
            default:
              break;
          }

          this.dispatch(AgentEvent.STRUCTURED_MESSAGE, data);
        } catch {
          this.dispatch(AgentEvent.UNKNOWN_MESSAGE);
        }
      }
    }

    async connect(): Promise<void> {
      // Since multiple attributes/properties on the element can be changed "at once" when starting
      // the agent (with successive synchronous setAttribute() calls) and any of those changes may
      // have triggered the connect, wait until all such updates have been made before executing the
      // connect routine, so we're sure we have all the current values.
      await Promise.resolve();

      const { apiKey } = this;
      if (apiKey === undefined) {
        this.dispatch(AgentEvent.NO_KEY);
        return;
      }
      const url = this.getAttribute(Attributes.url);
      if (!url) {
        this.dispatch(AgentEvent.NO_URL);
        return;
      }
      const configAttr = this.getAttribute(ObservedAttributes.config);
      if (!configAttr) {
        this.dispatch(AgentEvent.NO_CONFIG);
        return;
      }

      if (!this.micContext || !this.ttsContext || !this.ttsAnalyser) {
        this.dispatch(AgentEvent.FAILED_SETUP);
        return;
      }

      await this.resumeContext();

      const nodesAndMicAndConfigString: Result<
        [UserMediaNodes, WebSocket, string],
        AgentEventDetail
      > = pairResults(
        (await getNodes(this.micContext)).andThen((nodes) =>
          this.connectNodes(nodes),
        ),
        await openWebSocket(url, apiKey),
      ).andThen(([nodes, socket]) =>
        getConfigString(configAttr).map((configString) => [
          nodes,
          socket,
          configString,
        ]),
      );

      match(
        {
          Ok: ([{ processor, analyser }, socket, configString]: [
            UserMediaNodes,
            WebSocket,
            string,
          ]) => {
            sendVolumeUpdates(analyser, this.hal, "user-volume");

            const sendMicToSocket = sendMicTo(socket);

            socket.addEventListener("close", (event: CloseEvent) => {
              this.dispatch(AgentEvent.SOCKET_CLOSE, event);
              processor.removeEventListener("audioprocess", sendMicToSocket);
              this.startIdleTimeout.clear();
            });
            socket.addEventListener(
              "message",
              this.handleSocketMessage.bind(this),
            );
            this.socket = socket;

            this.dispatch(AgentEvent.SOCKET_OPEN);
            this.sendClientMessage(configString);
            this.startIdleTimeout();

            processor.addEventListener("audioprocess", sendMicToSocket);

            this.hal.setAttribute("orb-state", VoiceBotStatus.Active);
          },
          Err: async ({ variant, detail }) => {
            await this.disconnect();
            this.dispatch(variant, detail);
          },
        },
        nodesAndMicAndConfigString,
      );
    }

    private stopTts() {
      this.scheduledPlaybackSources.forEach((source) => source.stop());
      this.scheduledPlaybackSources.clear();
      this.startTime = -1;
    }

    private async clearMicrophone() {
      this.microphone?.mediaStream.getTracks().forEach((t) => t.stop());
      this.microphone = null;
    }

    private clearSocket(reason?: string) {
      return new Promise<void>((resolve) => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.addEventListener("close", () => {
            this.socket = null;
            resolve();
          });

          if (reason) {
            this.socket.close(1000, reason);
          } else {
            this.socket.close(1000);
          }
        } else {
          this.socket = null;
          resolve();
        }
      });
    }

    async disconnect(reason?: string): Promise<void> {
      this.stopTts();
      await this.suspendContext();
      this.disconnectNodes();
      await this.clearSocket(reason);
      await this.clearMicrophone();
      this.hal.setAttribute("orb-state", VoiceBotStatus.Sleeping);
    }

    async restart() {
      await this.disconnect();
      this.connect();
    }

    async attributeChangedCallback(
      name: string,
      oldValue: string,
      newValue: string,
    ) {
      switch (name) {
        case ObservedAttributes.config:
          if (!oldValue && newValue) {
            await this.connect();
          } else if (oldValue && !newValue) {
            await this.disconnect();
          } else if (newValue && this.socket) {
            this.restart();
          }
          break;

        case ObservedAttributes.idleTimeoutMs:
          this.replaceIdleTimeout(newValue);
          break;

        default:
          break;
      }
    }

    async disconnectedCallback() {
      await this.disconnect();
      await this.closeContext();
    }

    async connectedCallback() {
      this.hal.setAttribute("agent-volume", "0");
      this.hal.setAttribute("user-volume", "0");
      this.hal.setAttribute("orb-state", VoiceBotStatus.NotStarted);
      this.hal.setAttribute(
        "height",
        this.getAttribute(Attributes.height) ?? "200",
      );
      this.hal.setAttribute(
        "width",
        this.getAttribute(Attributes.width) ?? "300",
      );
      this.appendChild(this.hal);

      this.replaceIdleTimeout(
        this.getAttribute(ObservedAttributes.idleTimeoutMs),
      );
    }
  },
);
