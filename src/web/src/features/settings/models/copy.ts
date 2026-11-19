/**
 * Every word a person reads in Settings › AI & Models, in one place so the
 * voice stays consistent. Readers are mostly non-technical (students, people
 * new to AI): plain words, short sentences, no jargon unless unavoidable.
 *
 * House style: sentence case, curly apostrophes (’), no exclamation marks,
 * no em dashes, short descriptions, 1 to 3 word button labels.
 */

export const MODELS_COPY = {
  /** Shown above three cards only while nothing is connected. */
  quickStart: {
    heading: "How do you want to use AI?",
    subscription: { title: "Use a paid plan", body: "Sign in to Claude or ChatGPT in your browser." },
    apiKey: { title: "Use an API key", body: "Start free with Google Gemini, or paste a key from another service." },
    local: { title: "Keep it on this computer", body: "Run free models with Ollama or LM Studio." },
  },

  /** The section headings, top to bottom, with an optional one-line note under each group. */
  sections: {
    popular: { label: "Popular", note: "Sign in with a paid plan, or add an API key." },
    cloud: { label: "More AI services", note: "Each connects with an API key from its website." },
    local: { label: "On this computer", note: "Free models that run right here." },
    custom: { label: "Your own server", note: "" },
    reliability: { label: "If a model stops answering", note: "" },
  },

  /** One short line under each service’s name while it isn’t set up yet (≤ 44 characters). */
  taglines: {
    claude: "Your Claude plan or an API key",
    openai: "Your ChatGPT plan or an API key",
    google: "Free with a Google API key",
    openrouter: "Many models with one API key",
    groq: "Fast replies with an API key",
    together: "Open-source models in the cloud",
    mistral: "Mistral’s AI models",
    deepseek: "DeepSeek’s AI models",
    xai: "Grok AI models",
    ollama: "Free models on this computer",
    lmstudio: "Free models on this computer",
    custom: "Any OpenAI-compatible server address",
  } as Record<string, string>,

  /** Row states (≤ 24 characters). */
  status: {
    notSetUp: "Not set up",
    setUp: "Set up",
    ready: "Ready",
    readyPlan: (plan: string) => `Ready · ${plan}`,
    readySubscription: "Ready · Signed in",
    readyApiKey: "Ready · API key",
    readyBoth: "Ready · Plan and key",
    chooseModel: "Choose a model",
    foundLocal: "Found on this computer",
    checking: "Checking…",
    notRunning: "Not running",
    needsKey: "Needs a key",
    needsAddress: "Needs an address",
    notSupported: "Not supported yet",
    /** Beside the service new chats use. */
    default: "Default",
  },

  /** Inside an opened Claude / ChatGPT / Gemini row: the two ways to connect. */
  brands: {
    claude: {
      subscriptionTab: "Claude plan",
      subscriptionBody: "Sign in to your Claude plan in your browser, so Phaethon never sees your password.",
      apiBody: "Pay Anthropic for what you use, with your key stored in this computer’s keychain.",
    },
    openai: {
      subscriptionTab: "ChatGPT plan",
      subscriptionBody: "Sign in to your ChatGPT plan in your browser, so Phaethon never sees your password.",
      apiBody: "Pay OpenAI for what you use, with your key stored in this computer’s keychain.",
    },
    google: {
      subscriptionTab: "Google account",
      subscriptionBody: "Gemini CLI isn’t available on many personal Google accounts, so a free API key from Google AI Studio is usually easier.",
      apiBody: "Paste a free key from Google AI Studio, and it stays in this computer’s keychain.",
    },
    apiTab: "API key",
  },

  /** Setting up a plan (installs the maker’s own tool, then opens sign-in). */
  setup: {
    title: (tool: string) => `Set up ${tool}`,
    body: (tool: string, maker: string) => `Phaethon installs ${tool}, ${maker}’s free tool, then opens the sign-in page in your browser.`,
    button: "Install and connect",
    installing: (tool: string) => `Installing ${tool}…`,
    signingIn: "Finish sign-in in your browser…",
    cancel: "Cancel",
    retry: "Try again",
    useKeyInstead: "Use API key",
    manualToggle: "Install in Terminal",
    manualLabel: "Paste this into Terminal",
    copy: "Copy",
    checkAgain: "Check again",
    checking: "Checking…",
    /** Gemini CLI has no installer Phaethon can run. */
    manualOnly: (tool: string) => `Install ${tool} in Terminal, then come back and check again.`,
  },

  /** Removing a connected API-key service. */
  remove: {
    button: (name: string) => `Remove ${name}`,
    title: (name: string) => `Remove ${name}?`,
    confirm: "Remove",
    bodyWithKey: "This deletes the key from this computer’s keychain and resets its settings. Chats that use it stop answering until you set it up again.",
    bodyNoKey: "This resets its saved settings. Chats that use it stop answering until you set it up again.",
    done: (name: string) => `${name} removed`,
    failed: (name: string) => `Couldn’t remove ${name}`,
  },

  fallback: {
    label: "Switch to another model automatically",
    description: "If a model fails, Phaethon switches to another model you’ve set up and notes which one took over.",
    failed: "Couldn’t update this setting",
  },

  /** Under a signed-in plan's accounts: read its usage limits and model list again. */
  refresh: {
    label: "Models and usage",
    button: "Refresh",
    busy: "Refreshing…",
  },

  errors: {
    load: "Couldn’t load AI & Models",
    refresh: "Couldn’t refresh AI & Models",
  },
} as const;
