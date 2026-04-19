<script setup>
// ModalHost：集中渲染所有迁移到 Vue 的 modal
//
// 工作机制：
// - 通过 inject('vueBridge') 拿到桥接实例；
// - 每个迁移过来的 modal SFC 在这里挂一次，并通过 vueBridge.registerModal('xxx')
//   登记 modalId，使得原生侧的 showModal('xxx') / hideModal('xxx') 自动转发到 Vue；
// - modal 的 visible 直接绑定到 bridge.state.activeModals[name].visible，
//   原生 JS 调用 window.vueBridge.openModal('xxx', payload) 即可弹出。

import { inject, onMounted } from 'vue';
import ModalRemark from './ModalRemark.vue';
import ModalGroup from './ModalGroup.vue';
import ModalTest from './ModalTest.vue';
import ModalApplyShopCategory from './ModalApplyShopCategory.vue';
import ModalApiImagePreview from './ModalApiImagePreview.vue';
import ModalInvoiceApiFilePreview from './ModalInvoiceApiFilePreview.vue';
import ModalApiGoodsSpec from './ModalApiGoodsSpec.vue';
import ModalApiRefundOrderSelect from './ModalApiRefundOrderSelect.vue';
import ModalApiRefund from './ModalApiRefund.vue';
import ModalApiSmallPaymentOrderSelect from './ModalApiSmallPaymentOrderSelect.vue';
import ModalApiSmallPayment from './ModalApiSmallPayment.vue';
import ModalApiInviteOrder from './ModalApiInviteOrder.vue';
import ModalApiInviteOrderSpec from './ModalApiInviteOrderSpec.vue';
import ModalPhrases from './ModalPhrases.vue';
import ModalBind from './ModalBind.vue';
import ModalExam from './ModalExam.vue';
import ModalQA from './ModalQA.vue';
import ModalInvoiceApiEntry from './ModalInvoiceApiEntry.vue';

const vueBridge = inject('vueBridge');

const ownedModals = [
  'modalRemark',
  'modalGroup',
  'modalTest',
  'modalApplyShopCategory',
  'modalApiImagePreview',
  'modalInvoiceApiFilePreview',
  'modalApiGoodsSpec',
  'modalApiRefundOrderSelect',
  'modalApiRefund',
  'modalApiSmallPaymentOrderSelect',
  'modalApiSmallPayment',
  'modalApiInviteOrder',
  'modalApiInviteOrderSpec',
  'modalPhrases',
  'modalBind',
  'modalExam',
  'modalQA',
  'modalInvoiceApiEntry',
];

onMounted(() => {
  ownedModals.forEach((name) => vueBridge.registerModal(name));
});

function isOpen(name) {
  return Boolean(vueBridge.state.activeModals[name]?.visible);
}

function payloadOf(name) {
  return vueBridge.state.activeModals[name]?.payload || {};
}

function close(name) {
  vueBridge.closeModal(name);
}
</script>

<template>
  <div class="modal-host" data-vue-bridge-ready="true">
    <ModalRemark
      :visible="isOpen('modalRemark')"
      :payload="payloadOf('modalRemark')"
      @update:visible="(val) => !val && close('modalRemark')"
      @close="close('modalRemark')"
    />
    <ModalGroup
      :visible="isOpen('modalGroup')"
      :payload="payloadOf('modalGroup')"
      @update:visible="(val) => !val && close('modalGroup')"
      @close="close('modalGroup')"
    />
    <ModalTest
      :visible="isOpen('modalTest')"
      :payload="payloadOf('modalTest')"
      @update:visible="(val) => !val && close('modalTest')"
      @close="close('modalTest')"
    />
    <ModalApplyShopCategory
      :visible="isOpen('modalApplyShopCategory')"
      :payload="payloadOf('modalApplyShopCategory')"
      @update:visible="(val) => !val && close('modalApplyShopCategory')"
      @close="close('modalApplyShopCategory')"
    />
    <ModalApiImagePreview
      :visible="isOpen('modalApiImagePreview')"
      :payload="payloadOf('modalApiImagePreview')"
      @update:visible="(val) => !val && close('modalApiImagePreview')"
      @close="close('modalApiImagePreview')"
    />
    <ModalInvoiceApiFilePreview
      :visible="isOpen('modalInvoiceApiFilePreview')"
      :payload="payloadOf('modalInvoiceApiFilePreview')"
      @update:visible="(val) => !val && close('modalInvoiceApiFilePreview')"
      @close="close('modalInvoiceApiFilePreview')"
    />
    <ModalApiGoodsSpec
      :visible="isOpen('modalApiGoodsSpec')"
      :payload="payloadOf('modalApiGoodsSpec')"
      @update:visible="(val) => !val && close('modalApiGoodsSpec')"
      @close="close('modalApiGoodsSpec')"
    />
    <ModalApiRefundOrderSelect
      :visible="isOpen('modalApiRefundOrderSelect')"
      :payload="payloadOf('modalApiRefundOrderSelect')"
      @update:visible="(val) => !val && close('modalApiRefundOrderSelect')"
      @close="close('modalApiRefundOrderSelect')"
    />
    <ModalApiRefund
      :visible="isOpen('modalApiRefund')"
      :payload="payloadOf('modalApiRefund')"
      @update:visible="(val) => !val && close('modalApiRefund')"
      @close="close('modalApiRefund')"
    />
    <ModalApiSmallPaymentOrderSelect
      :visible="isOpen('modalApiSmallPaymentOrderSelect')"
      :payload="payloadOf('modalApiSmallPaymentOrderSelect')"
      @update:visible="(val) => !val && close('modalApiSmallPaymentOrderSelect')"
      @close="close('modalApiSmallPaymentOrderSelect')"
    />
    <ModalApiSmallPayment
      :visible="isOpen('modalApiSmallPayment')"
      :payload="payloadOf('modalApiSmallPayment')"
      @update:visible="(val) => !val && close('modalApiSmallPayment')"
      @close="close('modalApiSmallPayment')"
    />
    <ModalApiInviteOrder
      :visible="isOpen('modalApiInviteOrder')"
      :payload="payloadOf('modalApiInviteOrder')"
      @update:visible="(val) => !val && close('modalApiInviteOrder')"
      @close="close('modalApiInviteOrder')"
    />
    <ModalApiInviteOrderSpec
      :visible="isOpen('modalApiInviteOrderSpec')"
      :payload="payloadOf('modalApiInviteOrderSpec')"
      @update:visible="(val) => !val && close('modalApiInviteOrderSpec')"
      @close="close('modalApiInviteOrderSpec')"
    />
    <ModalPhrases
      :visible="isOpen('modalPhrases')"
      :payload="payloadOf('modalPhrases')"
      @update:visible="(val) => !val && close('modalPhrases')"
      @close="close('modalPhrases')"
    />
    <ModalBind
      :visible="isOpen('modalBind')"
      :payload="payloadOf('modalBind')"
      @update:visible="(val) => !val && close('modalBind')"
      @close="close('modalBind')"
    />
    <ModalExam
      :visible="isOpen('modalExam')"
      :payload="payloadOf('modalExam')"
      @update:visible="(val) => !val && close('modalExam')"
      @close="close('modalExam')"
    />
    <ModalQA
      :visible="isOpen('modalQA')"
      :payload="payloadOf('modalQA')"
      @update:visible="(val) => !val && close('modalQA')"
      @close="close('modalQA')"
    />
    <ModalInvoiceApiEntry
      :visible="isOpen('modalInvoiceApiEntry')"
      :payload="payloadOf('modalInvoiceApiEntry')"
      @update:visible="(val) => !val && close('modalInvoiceApiEntry')"
      @close="close('modalInvoiceApiEntry')"
    />
  </div>
</template>

<style>
.modal-host {
  display: contents;
}
</style>
