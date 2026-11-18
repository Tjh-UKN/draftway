northstar.commands.register('tidy-lines', async () => {
  const note = await northstar.note.read();
  // Keep fenced code verbatim; only collapse excess blank lines in prose.
  let fence = null;
  let blank = false;
  const lines = note.text.split('\n').filter(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      blank = false;
      return true;
    }
    if (fence) return true;
    const empty = !line.trim();
    const keep = !empty || !blank;
    blank = empty;
    return keep;
  });
  const text = lines.join('\n');
  if (text !== note.text) await northstar.note.edit({from: 0, to: note.text.length, text, revision: note.revision});
});
