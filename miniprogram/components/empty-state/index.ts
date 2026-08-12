Component({
  properties: {
    image: { type: String, value: '/assets/png/empty-pantry.png' },
    title: { type: String, value: '这里还空着' },
    description: { type: String, value: '添加一些内容后，就会在这里出现。' },
    actionText: { type: String, value: '' },
  },
  methods: { onAction() { this.triggerEvent('action'); } },
});
