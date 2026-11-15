import { getName } from './names.ts';

const name = getName('a');
if (name === '') throw new Error();
