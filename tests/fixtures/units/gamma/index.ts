import type { Provider } from '../../../../src/index.js';

export default [
  { provide: 'g1', useValue: 1 },
  { provide: 'g2', useValue: 2 },
] satisfies Provider[];
