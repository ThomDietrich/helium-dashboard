const {InfluxDB, Point} = require('@influxdata/influxdb-client');
const {DeleteAPI} = require('@influxdata/influxdb-client-apis')

class InfluxSingleton {
  static instance;

  constructor() {

    if (!process.env.INFLUX_HOST || !process.env.INFLUX_TOKEN || !process.env.INFLUX_ORG || !process.env.INFLUX_BUCKET) {
      console.log("Necessary environment variables missing. Exiting.")
      process.exit(1)
    }

    if (!process.env.INFLUX_PORT) {
      process.env.INFLUX_PORT = '8086'
    }

    if (this.instance) {
      console.log("Influx: reusing instance");
      return instance;
    }

    console.log("Influx: initializing");
    this.influx = new InfluxDB({
      url: `https://${process.env.INFLUX_HOST}:${process.env.INFLUX_PORT}`,
      token: process.env.INFLUX_TOKEN,
    });

    this.instance = this;
  }

  open() {
    this.write = this.influx.getWriteApi(process.env.INFLUX_ORG, process.env.INFLUX_BUCKET, 'ns');
    this.query = this.influx.getQueryApi(process.env.INFLUX_ORG);
    this.delete = new DeleteAPI(this.influx);
  }

  flush() {
    return this.write.flush();
  }

  close() {
    return this.write.close();
  }
}

const Influx = new InfluxSingleton();

module.exports = {Influx, Point};
