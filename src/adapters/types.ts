export type AdapterSetupEdit = {
  path: string;
  original?: string;
  content: string;
};

export type AdapterRegistration = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type AdapterSetupContext = {
  entry: string;
  configHome: string;
  skillContent: string;
  dataDir: string;
  readFile: (path: string) => string | undefined;
  registration: AdapterRegistration;
};

export type AdapterCommandSpec = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type AdapterLookupOptions = {
  includeExperimental?: boolean;
};

export type ClientAdapter = {
  readonly id: string;
  readonly displayName: string;
  readonly experimental: boolean;
  readonly executable: string;
  setup(context: AdapterSetupContext): AdapterSetupEdit[];
  doctor(platform?: NodeJS.Platform): string;
  launch(workspace: string, prompt?: string, platform?: NodeJS.Platform): AdapterCommandSpec;
  resume(sessionId: string, workspace: string, platform?: NodeJS.Platform): AdapterCommandSpec;
  discoverSessionId(payload: unknown): Record<string, unknown>;
};
