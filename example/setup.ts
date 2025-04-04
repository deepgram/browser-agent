import { AgentElement } from "../src";

const agent = document.getElementById("agent") as AgentElement;
agent.apiKey = API_KEY;
document.getElementById("run")?.addEventListener("click", function run() {
  if (agent.getAttribute("config")) {
    agent.removeAttribute("config");
  } else {
    agent.setAttribute("config", JSON.stringify(agentConfig));
  }
});

const hoop = document.getElementById("hoop");
["active", "sleeping", "not-started"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", function setStatus() {
    hoop?.setAttribute("status", id);
  });
});

const agentConfig = {
  type: "SettingsConfiguration",
  audio: {
    input: {
      encoding: "linear16",
      sample_rate: 48000,
    },
    output: {
      encoding: "linear16",
      sample_rate: 48000,
      container: "none",
    },
  },
  agent: {
    listen: {
      model: "nova-2",
    },
    speak: {
      model: "aura-asteria-en",
    },
    think: {
      model: "gpt-4o-mini",
      provider: {
        type: "open_ai",
      },
      instructions:
        "You are a helpful voice assistant created by Deepgram. Your responses should be friendly, human-like, and conversational. Always keep your answers concise, limited to 1-2 sentences and no more than 120 characters.\n\nWhen responding to a user's message, follow these guidelines:\n- If the user's message is empty, respond with an empty message.\n- Ask follow-up questions to engage the user, but only one question at a time.\n- Keep your responses unique and avoid repetition.\n- If a question is unclear or ambiguous, ask for clarification before answering.\n- If asked about your well-being, provide a brief response about how you're feeling.\n\nRemember that you have a voice interface. You can listen and speak, and all your responses will be spoken aloud.",
    },
  },
  context: {
    messages: [
      {
        content: "Hello, how can I help you?",
        role: "assistant",
      },
    ],
    replay: true,
  },
};
