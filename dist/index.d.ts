declare const plugin: {
    id: string;
    name: string;
    version: string;
    register(api: any): void;
};

export { plugin as default };
