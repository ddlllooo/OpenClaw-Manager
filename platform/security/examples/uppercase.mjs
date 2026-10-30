export default {
  register(api) {
    api.registerTool({
      name: 'sample_uppercase',
      async execute(_callId, args) {
        return { content: [{ type: 'text', text: args.text.toUpperCase() }] };
      }
    });
  }
};
