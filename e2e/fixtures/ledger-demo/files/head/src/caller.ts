import { readName } from './names.ts';

const name = readName('a');
if (name === '') throw new Error();
