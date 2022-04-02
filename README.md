# Helium Exporter and Dashboard

![Dashboard account view](/images/dashboard-account.png)

The dashboard shows general network and account stats, followed by insights per observed hotspot:

![Dashboard hotspot view](/images/dashboard-hotspot.png)

## Overview
The provided tool collects data from the Helium API and stores it in InfluxDB.
Grafana reads the data from InfluxDB and presents it in the provided dashboard.

These instructions do not go through the setup of InfluxDB and Grafana.

## Data retrieval
This node package collects data from Helium API.
It can be run in many environments with Node.js, including the provided Docker image or on AWS Lambda.

This script collects data once and, therefore, must be run periodically (e.g., every 15 mins).
Some example on how to do that:
* AWS Lambda function triggered by CloudWatch event
* Cron job inside the provided Docker image (preconfigured)
* Cron job on remote server (perhaps same one that runs Influx & Grafana)
* Cron job on local machine (if machine is asleep, it won't run, discouraged)

### Setup

Copy the supplied `.env.sample` file to `.env`, and update the necessary environment variables inside.

To test the script and your provided variables, execute using `npm start`.

### Historic Data

The Helium API does provide historic data. To export your history to InfluxDB, increase the retrieval window temporarily:

```
HELIUM_ACTIVITY_LOOKBACK_HOURS=900 npm start
```

## Using the provided Grafana dashboard
* Use latest version of Grafana
* Import the provided dashboard json file.
* Inside the general dashboard configuration: Set predefined variables per your setup and needs.

## Execution in a Dockerized Environment

The provided Dockerfile can be used to run this app periodically inside a container.
Example of a `docker-compose.yaml` (adapt to your needs):

```yaml
  helium-exporter:
    build:
      context: ./helium-exporter-grafana
    image: helium-exporter:latest
    depends_on:
      - influxdb
    environment:
      INFLUX_HOST: ${MONITORING_HOST}
      INFLUX_PORT: 8086
      INFLUX_BUCKET: helium
      INFLUX_ORG: myorg
      INFLUX_TOKEN: ${INFLUX_WRITE_TOKEN}
      HELIUM_WALLET: ${HELIUM_WALLET}
      HELIUM_HOTSPOT: ${HELIUM_HOTSPOT}
```
