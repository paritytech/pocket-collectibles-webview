// The product's DotNS identity: the namespace a product-sdk host scopes
// OUR product accounts (and purse subtree) to.
//
// OPEN QUESTION (team): the value is not ratified — it must be the
// product's registered DotNS name, and the mint/claim pipeline must agree
// to deposit into these product accounts by derivation index (this
// replaces the dev `//nft//<i>` convention inside a container; the two
// schemes yield DIFFERENT addresses). host-demo uses "host-demo.dot".
export const DOTNS_IDENTIFIER = 'pocket-collectibles.dot'
