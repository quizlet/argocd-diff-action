import os from 'os';

describe('main', () => {
  // shows how the runner will run a javascript action with env / stdout protocol
  test('test runs', async () => {
    process.env['RUNNER_TEMP'] = os.tmpdir();
    process.env['GITHUB_REPOSITORY'] = 'quizlet/cd-infra';
    process.env['INPUT_GITHUB-TOKEN'] = '500';
    process.env['INPUT_ARGOCD-VERSION'] = 'v1.6.1';
    process.env['INPUT_ARGOCD-SERVER-URL'] = 'argocd.qzlt.io';
    process.env['INPUT_ARGOCD-TOKEN'] = 'foo';
    expect(import('../src/main')).resolves.toBeTruthy();
  });
});
