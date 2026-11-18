// YN-212: a Project's page reads by request. A request's tasks and their
// cards, and the cards no request has (the Project's own block, open by
// itself only on a page with no request), are folded in their blocks. A test
// that reads a card on the page unfolds every block first, as a reader
// would; React draws them on its next turn, so call it where a test polls.
export function unfoldBlocks(document) {
  for (const button of document.querySelectorAll('.request-block-more[aria-expanded="false"]')) button.click();
}
