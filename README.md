# ArgoCD Diff GitHub Action

This action generates a diff between the current PR and the current state of the cluster. 

Note that this includes any changes between your branch and latest `master`, as well as ways in which the cluster is out of sync. 

This is a fork of the original [argocd-diff-action](https://github.com/quizlet/argocd-diff-action) repository. This fork was created to update the github action in order for it to work with more recent versions of ArgoCD by removing the API call to get the list of ArgoCD apps and using the CLI instead.

## Usage

Example GH action:
```yaml
name: ArgoCD Diff

on:
  pull_request:
    branches: [master, main]

jobs:
  argocd-diff:
    name: Generate ArgoCD Diff
    runs-on: ubuntu-latest
    steps:

      - name: Checkout repo
        uses: actions/checkout@v2

      - uses: lalalilo/argocd-diff-action@master
        name: ArgoCD Diff
        with:
          argocd-server-url: argocd.example.com
          argocd-token: ${{ secrets.ARGOCD_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          argocd-version: v1.6.1
          argocd-extra-cli-args: --grpc-web
```

## How it works

1. Downloads the specified version of the ArgoCD binary, and makes it executable
2. Connects to the ArgoCD API using the `argocd-token`, and gets all the apps
3. Filters the apps to the ones that live in the current repo
4. Runs `argocd app diff` for each app
5. Posts the diff output as a comment on the PR

## Publishing

Build the script and commit to your branch:
`npm run build && npm run pack`
Commit the build output, and make a PR.
