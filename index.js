const {Influx} = require('./src/influx');
const helium = require('./src/helium');

exports.handler = async (event, context) => {
  console.log();
  //console.log('Node ver:', process.version);
  //console.log('Received event:', JSON.stringify(event, null, 2));
  console.log(`Helium API to InfluxDB exporter, running at ${new Date()}`);

  Influx.open();

  // right now there's only one task but in the future multiple tasks can be done in parallel
  let tasks = [
      { name: 'Helium', promise: helium.processHelium(), },
    ];
  const results = await Promise.allSettled(tasks.map(t => t.promise));

  await Influx.close();

  var firstFailure;

  results.forEach((r, idx) => {
    console.log(`${tasks[idx].name}: ${r.status}`);
    if (r.status === 'rejected') {
      //console.log('  -> Error:', r.reason.message);
      console.log('  -> Error:', r);
      // first encountered failure will be thrown as error for the lambda result
      if (!firstFailure) {
        firstFailure = r.reason.message;
      }
    }
  })

  if (firstFailure) {
    throw firstFailure;
  }

  const response = 'Done';

  return response;
};
