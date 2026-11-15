// Stub que simula crash entre a extração/move e a gravação do estado (RED 6):
// executa o fluxo normal até o ponto pós-move e mata o processo com exit≠0
// ANTES de qualquer gravação de estado pelo script.
console.log("import stub: simulating crash before commit");
process.exit(137);
