export function parseArguments(input) {
  const argumentsList = [];
  let current = '';
  let quote = null;
  let escaping = false;
  let tokenStarted = false;

  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      tokenStarted = true;
    } else if (character === '\\' && quote !== "'") {
      escaping = true;
      tokenStarted = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else current += character;
      tokenStarted = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        argumentsList.push(current);
        current = '';
        tokenStarted = false;
      }
    } else {
      current += character;
      tokenStarted = true;
    }
  }

  if (escaping) throw new Error('Arguments cannot end with an escape character.');
  if (quote) throw new Error(`Arguments contain an unclosed ${quote} quote.`);
  if (tokenStarted) argumentsList.push(current);
  return argumentsList;
}
