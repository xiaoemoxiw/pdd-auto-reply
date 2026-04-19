// 商品规格 modal shim
//
// UI 与异步加载逻辑已迁移到 src/renderer/vue/modals/ModalApiGoodsSpec.vue。
// 这里仅保留 window.openApiGoodsSpecModal / closeApiGoodsSpecModal 作为兼容入口，
// 让 chat-api-module 与 index.html 里的旧调用点（点击商品卡片"查看商品规格"等）不需要改动。
// 与 vue 组件之间通过 window.vueBridge.openModal / closeModal 桥接，
// 商品 card 通过 payload 传入，loading/error/empty 状态都由组件自己维护。
(function () {
  function openApiGoodsSpecModal(card = {}) {
    if (window.vueBridge && typeof window.vueBridge.openModal === 'function') {
      window.vueBridge.openModal('modalApiGoodsSpec', { card });
      return;
    }
    if (typeof window.showModal === 'function') {
      window.showModal('modalApiGoodsSpec');
    }
  }

  function closeApiGoodsSpecModal() {
    if (window.vueBridge && typeof window.vueBridge.closeModal === 'function') {
      window.vueBridge.closeModal('modalApiGoodsSpec');
      return;
    }
    if (typeof window.hideModal === 'function') {
      window.hideModal('modalApiGoodsSpec');
    }
  }

  window.openApiGoodsSpecModal = openApiGoodsSpecModal;
  window.closeApiGoodsSpecModal = closeApiGoodsSpecModal;
})();
