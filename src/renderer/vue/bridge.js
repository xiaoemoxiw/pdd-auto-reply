// 原生 JS ↔ Vue 子树之间的桥接层
//
// 设计目标：
// 1. 现有 30+ 个原生 JS 模块仍是 IIFE 结构，无法 import Vue 组件。
//    通过 window.vueBridge 暴露 openModal / closeModal / on / emit 等方法让原生侧调用 Vue 组件。
// 2. Vue 内部通过 inject('vueBridge') 拿到同一个实例，避免双向耦合。
// 3. 不替换现有 hideModal('modalXxx') 调用点：兼容写在迁移阶段维护，逐个 modal 替换为 vueBridge.closeModal(name)。

import { reactive } from 'vue';

export function createVueBridge() {
  const state = reactive({
    activeModals: {},
  });

  const listeners = new Map();

  // 已被 Vue 接管的 modalId 集合
  // 在 ModalHost.vue 中通过 vueBridge.registerModal('xxx') 登记
  // 一旦登记，原生侧的 showModal('xxx') / hideModal('xxx') 会被自动转发到 Vue
  const ownedModals = new Set();

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => off(event, handler);
  }

  function off(event, handler) {
    const set = listeners.get(event);
    if (set) set.delete(handler);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    set.forEach((handler) => {
      try {
        handler(payload);
      } catch (err) {
        console.error('[vueBridge] listener error', event, err);
      }
    });
  }

  function openModal(name, payload = {}) {
    state.activeModals[name] = {
      visible: true,
      payload,
      openedAt: Date.now(),
    };
    emit(`modal:open:${name}`, payload);
  }

  function closeModal(name) {
    if (state.activeModals[name]) {
      state.activeModals[name].visible = false;
    }
    emit(`modal:close:${name}`, undefined);
  }

  function isModalOpen(name) {
    return Boolean(state.activeModals[name] && state.activeModals[name].visible);
  }

  function getModalPayload(name) {
    const entry = state.activeModals[name];
    return entry ? entry.payload : undefined;
  }

  function registerModal(name) {
    ownedModals.add(name);
  }

  function isOwnedModal(name) {
    return ownedModals.has(name);
  }

  // 劫持原生 window.showModal / hideModal：
  // 凡是被 Vue 接管的 modalId，自动转发；其余仍走原始实现，保持现有 18 个 modal 行为不变。
  function installShowModalProxy() {
    const originalShow = window.showModal;
    const originalHide = window.hideModal;

    if (typeof originalShow === 'function' && !originalShow.__vueBridgeProxied) {
      const wrappedShow = function (id, payload) {
        if (ownedModals.has(id)) {
          openModal(id, payload || {});
          return;
        }
        return originalShow(id);
      };
      wrappedShow.__vueBridgeProxied = true;
      window.showModal = wrappedShow;
    }

    if (typeof originalHide === 'function' && !originalHide.__vueBridgeProxied) {
      const wrappedHide = function (id) {
        if (ownedModals.has(id)) {
          closeModal(id);
          return;
        }
        return originalHide(id);
      };
      wrappedHide.__vueBridgeProxied = true;
      window.hideModal = wrappedHide;
    }
  }

  return {
    state,
    on,
    off,
    emit,
    openModal,
    closeModal,
    isModalOpen,
    getModalPayload,
    registerModal,
    isOwnedModal,
    installShowModalProxy,
  };
}
