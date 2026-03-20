import { registerOpenCodeBridgeTools } from "./registrar";

const plugin = {
  id: "opencode-bridge",
  name: "OpenCode Bridge",
  version: "0.1.0",
  register(api: any) {
    const cfg = (api as any)?.pluginConfig || {};
    registerOpenCodeBridgeTools(api, cfg);
  },
};

export default plugin;
