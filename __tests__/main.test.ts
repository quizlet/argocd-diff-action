import os from 'os';
import { run, filterAppsByName, type App } from '../src/main';

describe('Action', () => {
  // shows how the runner will run a javascript action with env / stdout protocol
  test('runs', async () => {
    process.env['RUNNER_TEMP'] = os.tmpdir();
    process.env['GITHUB_REPOSITORY'] = 'quizlet/cd-infra';
    process.env['INPUT_GITHUB-TOKEN'] = '500';
    process.env['INPUT_ARGOCD-VERSION'] = 'v1.6.1';
    process.env['INPUT_ARGOCD-SERVER-URL'] = 'argocd.qzlt.io';
    process.env['INPUT_ARGOCD-TOKEN'] = 'foo';
    expect(run()).rejects.toThrow();
  });

  describe('matches app names', () => {
    const makeApp = (name: string) => ({ metadata: { name } }) as App;

    test('allows all apps when matcher is empty', () => {
      expect(filterAppsByName([makeApp('foobar'), makeApp('bazqux')], '')).toEqual([
        makeApp('foobar'),
        makeApp('bazqux')
      ]);
    });

    test('allows only apps when matcher is provided', () => {
      expect(filterAppsByName([makeApp('foobar'), makeApp('bazqux')], 'foobar')).toEqual([
        makeApp('foobar')
      ]);
    });

    test('treats matcher as regex when it is delimited by slashes', () => {
      expect(filterAppsByName([makeApp('foobar'), makeApp('bazqux')], '/bar$/')).toEqual([
        makeApp('foobar')
      ]);
    });

    test('with negative lookahead in regex', () => {
      expect(filterAppsByName([makeApp('foobar'), makeApp('bazqux')], '/^(?!foobar$).*$/')).toEqual(
        [makeApp('bazqux')]
      );
    });
  });
});
