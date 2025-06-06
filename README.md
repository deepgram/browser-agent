# Browser Agent

A pair of experimental web components for integrating with Deepgram's Voice Agent API in a browser environment.

- The agent component is an all-in-one web component that manages the microphone, websocket, and
  animation. Add it to any page and get chatting!
- The hoop component is the animation, standalone. More useful when you've got your own rules for
  socket integration, and just want the look and feel!

## Installation

Install via github by adding to your package.json dependencies:

```json
  "@deepgram/browser-agent": "deepgram/browser-agent#main",
```

## Using the main component

Import the library anywhere for the component to be registered to `deepgram-agent`:

```js
import "@deepgram/browser-agent";
```

Then, render it where you like!

```html
  <body>
    <deepgram-agent
      id="dg-agent"
      api-url="wss://sts.sandbox.deepgram.com/agent"
      height="300"
      width="300"
      idle-timeout-ms="10000"
    ></deepgram-agent>
  </body>
```

Then add a `config` attribute after some user interaction to start a connection. See more in the
Attributes section.

### Attributes


- `config` (optional): stringified json of a `SettingsConfiguration` to send the API on initialization
  - Adding or removing the `config` attribute will start or stop (respectively) the WebSocket
    connection to the Deepgram API.
  - Because this web component directly manages the user's microphone, it requires a user action to
    attempt a connection. For that reason, you most likely want to first render the element
    _without_ a config.
  - For better early API flexibility, there is no validation. Use our docs to ensure your
    configuration matches.
    - [SettingsConfiguration](https://developers.deepgram.com/docs/voice-agent-settings-configuration)
  - Whenever `deepgram-agent` disconnects, unset the config and wait for another user interaction to
    set it and retrigger connection.
- `width` (optional, default = `"0"`): the width of the canvas for agent animation
  - The animation will always take up a (roughly) square area, so this should typically be the same
    value as `height`.
- `height` (optional, default = `"0"`): the height of the canvas for agent animation
  - The animation will always take up a (roughly) square area, so this should typically be the same
    value as `width`.
- `api-url` (required): The API url
  - Chances are you'll set this to `"https://api.deepgram.com/v1/agent"`!
- `idle-timeout-ms` (optional): how long to wait for user idleness before closing the socket
  - Timer starts whenever the user is expected to speak (meaning right when opening the connection,
    and right after each `AgentAudioDone` event).

### Properties

- `apiKey` (required): the key to use for accessing the Deepgram /agent API.

### Events

As an experimental tech, the `deepgram-agent` element emits a variety of events. You're more likely
to run into some than others.

#### Common events

- `"no key"`: emitted when trying to connect and API key is missing
- `"no url"`: emitted when trying to connect and API url is missing
- `"no config"`: emitted when trying to connect and config is missing
- `"socket open"`: socket successfully opened
- `"socket close"`: socket successfully closed
- `"connection timeout"`: socket failed to connect due to a timeout (10s)
- `"failed to connect user media"`: couldn't gain access to user's microphone, usually due to
  permission rejection
- `"structured message"`: got JSON from the API. This is the main event to pay attention to!
- `"client message"`: sent a JSON message to the API. Useful for debugging.

#### Uncommon events

- `"failed setup"`: some issue internal to the custom element occurred
- `"empty audio"`: got an empty message when expecting audio data
- `"unknown message"`: got a text message from the API that isn't valid JSON

### Methods

```ts
sendClientMessage(message: ArrayBuffer | string): void {}
```

Use this to send some (stringified) JSON or binary data to the server. Ignored when the websocket is
closed.

```ts
connect(): Promise<void> {}
```

Use this to explicitly connect. Prefer to handle this by setting the `config` attribute.

```ts
disconnect(reason?: string): Promise<void> {}
```

Use this to explicitly disconnect. Prefer to handle this by _removing_ the `config` attribute.

## Using the hoop component

The animation alone is available as a granular import, automatically registered as `deepgram-hoop`:

```js
import "@deepgram/browser-agent/hoop";
```

Then, render it where you like!

```html
  <body>
    <deepgram-hoop
      id="dg-hoop"
      height="300"
      width="300"
      status="active"
    ></deepgram-hoop>
  </body>
```

### Feeding audio data

The hoop component applies some size oscillation based on audio information:

- The output, i.e. agent audio (`agent-volume` attribute) expands
- The input, i.e. user audio (`user-volume` attribute) collapses

To ease jitter, each drawn arc trails behind a leader. You must provide amplitude data for both the
user and agent on a per-frame basis. See the `sendVolumeUpdates` function for a working example.

## Contributing

### Prerequisites

- [Node v18 or 20](https://nodejs.org/en/download/) (though I recommend installing it through
  [nvm](https://github.com/nvm-sh/nvm#installing-and-updating))

### Running locally

Use `npm run vite` to start a dev server. You'll need to set a `DG_API_KEY` environment variable in
order to open a connection.
