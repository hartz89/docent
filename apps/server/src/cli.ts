// `docent <command>`: `review` opens one PR in the local app; `serve` runs the launcher that
// opens reviews from links. Each command parses its own arguments.
if (process.argv[2] === 'serve') await import('./serve-cli.ts');
else await import('./review-cli.ts');
