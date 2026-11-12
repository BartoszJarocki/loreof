import { initBotId } from 'botid/client/core';

initBotId({
  protect: [
    { path: '/api/repositories', method: 'POST' },
    { path: '/api/waitlist', method: 'POST' },
  ],
});
