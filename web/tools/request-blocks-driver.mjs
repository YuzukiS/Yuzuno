// YN-212: a Project's page reads by request. A request's tasks and their
// cards are folded in their blocks, and the cards no request has in the
// Project cards group (R-27), open by itself only on a page with no request.
// A test that reads a card on the page unfolds every block and opens that
// group first, as a reader would; React draws them on its next turn, so call
// it where a test polls.
// R-45: a block unfolds at its cards (its conversation is the other view), and its evidence opens with it.
export function unfoldBlocks(document) {
  for (const button of document.querySelectorAll('.request-block-more:is([data-view="cards"], [data-evidence])[aria-expanded="false"]')) button.click();
  for (const group of document.querySelectorAll("details.project-cards:not([open])")) {
    group.open = true;
    // The details' own toggle comes a task later; the page draws the group's cards on it.
    group.dispatchEvent(new group.ownerDocument.defaultView.Event("toggle"));
  }
}
