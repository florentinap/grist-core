import {spawn} from 'child_process';

let grist;

function startGrist(newEnv) {
  const env = newEnv ? {...process.env, ...newEnv} : process.env;

  // H/T https://stackoverflow.com/a/36995148/11352427
  grist = spawn('./sandbox/run.sh', {
    env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  });
  grist.on('message', function(data) {
    if(data.newEnv) {
      console.log('Restarting Grist with new environment');

      // Note that we only set this event handler here, after we have
      // a new environment to reload with. Small chance of a race here
      // in case something else sends a SIGINT before we do it
      // ourselves further below.
      grist.on('exit', () => {
        grist = startGrist(data.newEnv);
      });

      grist.kill('SIGINT');
    }
  });
  return grist;
}

startGrist();
