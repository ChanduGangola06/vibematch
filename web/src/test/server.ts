import { setupServer } from 'msw/node';

/** Shared MSW server: tests add handlers with `server.use(...)`; unknown requests fail the test. */
export const server = setupServer();
