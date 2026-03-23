import { registerOpenCodeBridgeTools } from "./registrar";

const PLUGIN_VERSION = "0.1.5";

const plugin = {
  id: "opencode-bridge",
  name: "OpenCode Bridge",
  version: PLUGIN_VERSION,
  register(api: any) {
    const cfg = (api as any)?.pluginConfig || {};
    registerOpenCodeBridgeTools(api, cfg);
  },
};

export default plugin;
