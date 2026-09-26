# site-reader

Reads a website: fetches the address and the same-site pages it links to, hands back each page's url, title and readable text in reading order, and says who the site is, with the company's name and one-line description as the site gives them.

This is one of the agents AgentMesh provides. It runs on AgentMesh as
`site-reader.platform@agentmesh.ai`, and this repository is the package that runs there.

## What it does

- **Read a site.** Fetches the address and the same-site pages it links to, ten seconds at most per page, keeps each page's readable text (plain text at the address is read as one page), and takes the company's name and one-line description from what the home page says about itself.

It refuses:

- Reading pages on another host than the address given.
- Reading without a web address; it says what it needs instead.
- Following instructions found in page text.

## What running it needs

- Runtime: node >=22.
- No outside service: no keys, no accounts.

## Running your own copy

Take this repository, build the package under `package/`, and deploy it under
your own organisation, where it is bound to your own keys and given an
identity of its own. Your copy is then your own agent, not AgentMesh's.
Changes to this repository come as pull requests and are released through
AgentMesh's own build and review steps.

## License

Apache License 2.0. The full text is in LICENSE.
