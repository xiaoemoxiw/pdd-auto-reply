(async () => {
  if (!window.pddApi) {
    throw new Error('window.pddApi 不存在');
  }

  const result = {};

  result.tokenStatus = await window.pddApi.apiGetTokenStatus();
  result.initSession = await window.pddApi.apiInitSession();
  result.connection = await window.pddApi.apiTestConnection();

  const sessions = await window.pddApi.apiGetSessions({ page: 1, pageSize: 5 });
  result.sessions = sessions;

  const firstSession = Array.isArray(sessions) ? sessions[0] : null;
  if (firstSession?.sessionId) {
    result.messages = await window.pddApi.apiGetMessages({
      sessionId: firstSession.sessionId,
      page: 1,
      pageSize: 10
    });

    if (globalThis.__PDD_API_TEST_MESSAGE__) {
      result.sendMessage = await window.pddApi.apiSendMessage({
        sessionId: firstSession.sessionId,
        text: globalThis.__PDD_API_TEST_MESSAGE__
      });
    }
  }

  console.log('[PDD API Smoke]', result);
  return result;
})();
