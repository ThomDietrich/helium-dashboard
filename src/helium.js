const { DateTime } = require('luxon');
const { Client, RewardsV1, UnknownTransaction, Network} = require('@helium/http');
const { Influx, Point } = require('./influx');
const { default: axios } = require('axios');

// number of hours to go back to fetch hotspot activity
const ACTIVITY_LOOKBACK_HOURS = process.env.HELIUM_ACTIVITY_LOOKBACK_HOURS ? process.env.HELIUM_ACTIVITY_LOOKBACK_HOURS : 4;
const DEBUG_TO_CONSOLE = process.env.DEBUG_TO_CONSOLE ? true : false;

const processingTime = new Date(); // now
const helium_client = new Client(Network.production, { retry: 10 });

async function getPrice() {
  const response = await axios('https://api.coingecko.com/api/v3/simple/price?ids=helium&vs_currencies=USD,EUR');
  console.log('Helium: collecting price data');

  let point = new Point("helium_price")
  point.timestamp(processingTime);
  point.tag('source', 'CoinGecko');

  point.floatField('usd', response.data.helium.usd);
  point.floatField('eur', response.data.helium.eur);

  if (DEBUG_TO_CONSOLE) {
    console.log("\n=== Price " + "=".repeat(100));
    console.log(point)
  } else {
    Influx.write.writePoint(point);
  }
}

async function processAccountStats() {
  let data = await helium_client.accounts.get(process.env.HELIUM_WALLET);
  console.log('Helium: collecting account stats');
  let point = new Point("helium_account")
    .timestamp(processingTime)
    .tag('account', data.address)
  ;

  point.floatField('balance_hnt', data.balance.floatBalance);
  point.floatField('balance_staked_hnt', data.stakedBalance.floatBalance);
  point.floatField('balance_sec_hst', data.secBalance.floatBalance);
  point.floatField('balance_dc_dc', data.dcBalance.floatBalance);

  if (DEBUG_TO_CONSOLE) {
    console.log("\n=== Account Stats " + "=".repeat(100));
    console.log(point)
  } else {
    Influx.write.writePoint(point);
  }
}

async function processHotspotActivity(hotspotIdentifier, sinceDate) {
  let activities = [];
  let oldestTime = DateTime.now;
  let hotspot = await helium_client.hotspots.get(hotspotIdentifier);
  let hotspotName = hotspot.name.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
  let hotspotGeotext = hotspot.geocode.shortCity + ", " + hotspot.geocode.shortStreet;

  console.log(`Helium: fetching activities for ${hotspotName} since ${sinceDate.toString()}`);

  let point = new Point("helium_hotspot")
    .timestamp(processingTime)
    .tag('hotspot_id', hotspotIdentifier)
    .tag('hotspot_name', hotspotName)
    .tag('geotext', hotspotGeotext)
    .tag('latitude', hotspot.lat)
    .tag('longitude', hotspot.lng)
    .tag('mode', hotspot.mode)
  ;

  point.floatField('reward_scale', hotspot.rewardScale);

  if (hotspot.score) {
    point.floatField('score', hotspot.score);
  }

  if (DEBUG_TO_CONSOLE) {
    console.log("\n=== Hotspot Stats " + "=".repeat(100));
    console.log(point)
  } else {
    Influx.write.writePoint(point);
  }

  // fetch all activities after specified date
  let page = await hotspot.activity.list();
  while(page.data.length > 0 || page.hasMore) {
    let acts = page.data.filter(a => DateTime.fromSeconds(a.time) >= sinceDate);
    activities.push(...acts);
    // console.log(`Page ${page.data.length} vs filtered ${acts.length}`)
    if (acts.length < page.data.length || !page.hasMore) {
      // if data was filtered out (timestamp was reached) or no more data, then stop here
      break;
    }
    page = await page.nextPage();
  }

  if (activities.length == 0) {
    console.log(`Helium: no activities for ${hotspotName} since ${sinceDate.toString()}`);
    return;
  }

  // convert activities to Influx points
  const points = activities.map(act => {
    const point = new Point('helium_activity')
      .timestamp(DateTime.fromSeconds(act.time).toJSDate())
      .tag('hotspot_id', hotspotIdentifier)
      .tag('hotspot_name', hotspotName)
      .tag('geotext', hotspotGeotext)
    ;

    if (act instanceof RewardsV1 && act.type == 'rewards_v2') {
      // "Received Mining Reward"
      point.measurement('helium_reward')
      if (act.rewards.length == 1) {
        reward_type = act.rewards[0].type
        let reward_type_explorer = (reward_type == 'poc_witnesses') ? 'witness' : (
          (reward_type == 'poc_challengers') ? 'challenger' : (
            (reward_type == 'poc_challengees') ? 'beacon' : 'unknown'
          )
        )
        point.tag('reward_type_poc', reward_type);
        point.tag('reward_type_explorer', reward_type_explorer);
      } else {
        //console.log("Multiple reward types encounted:\n" + act.rewards)
        point.tag('reward_type_poc', 'misc');
        point.tag('reward_type_explorer', 'misc');
      }
      point.floatField('reward_hnt', act.totalAmount.floatBalance);

    } else if (act.type == 'poc_receipts_v1' && act.challenger == hotspotIdentifier) {
      // "Challenged Beaconer"
      point.tag('type', 'challenged_beaconer');
      point.tag('poc_result', act.path[0].result);

    } else if (act.type == 'poc_receipts_v1' && act.path[0].challengee == hotspotIdentifier) {
      // "Broadcast Beacon"
      point.tag('type', 'broadcast_beacon');
      point.tag('poc_result', act.path[0].result);
      point.intField('witnesses', act.path[0].witnesses.length);

    } else if (act.type == 'poc_receipts_v1' && act.path[0].witnesses.some(w => w.gateway == hotspotIdentifier)) {
      // "Witnessed Beacon"
      point.tag('type', 'witnessed_beacon');
      point.tag('poc_result', act.path[0].result);

    } else if (act.type == 'poc_request_v1' && act.challenger == hotspotIdentifier) {
      // "Constructed Challenge"
      point.tag('type', 'constructed_challenge');

    } else if (act.type == 'state_channel_close_v1') {
      // "Data Transfer"
      point.tag('type', 'data_transfer');
      point.intField('packets', act.stateChannel.summaries[0].num_packets);
      point.intField('dcs', act.stateChannel.summaries[0].num_dcs);

    } else {
      // catch unknown activity to be implemented
      point.tag('type', 'unknown');
    }

    point.booleanField('event', true);

    if (DEBUG_TO_CONSOLE) {
      console.log("\n=== Activity " + "=".repeat(100));
      console.log(act);
      console.log()
      console.log(point);
    }
    return point;
  });

  console.log(`Helium: fetched ${activities.length} activities for ${hotspotName} (first ${DateTime.fromSeconds(activities[activities.length-1].time).toString()})`);

  if (!DEBUG_TO_CONSOLE) {
    Influx.write.writePoints(points);
  }
}

async function processNetworkStats() {
  const response = await axios.get('https://api.helium.io/v1/stats');
  const data = response.data.data;
  console.log('Helium: collecting network stats');

  let point = new Point("helium_stats")
    .timestamp(processingTime)
  ;

  point.intField('transactions', data.counts.transactions);
  point.intField('challenges', data.counts.challenges);
  point.intField('blocks', data.counts.blocks);

  point.intField('challenges_active', data.challenge_counts.active);

  if (DEBUG_TO_CONSOLE) {
    console.log("\n=== Network Stats " + "=".repeat(100));
    console.log(point)
  } else {
    Influx.write.writePoint(point);
  }
}

async function processHelium() {
  console.log('Processing Helium');

  if (!process.env.HELIUM_HOTSPOT || !process.env.HELIUM_WALLET) {
    console.log("Necessary environment variables missing. Exiting.")
    process.exit(1)
  }

  let processHotspotsList = (process.env.HELIUM_HOTSPOT.split(",")).map(function (hotspot) {
    return processHotspotActivity(hotspot.trim(), DateTime.local().minus({ hours: ACTIVITY_LOOKBACK_HOURS }));
  });

  await Promise.all([
    ...processHotspotsList,
    processNetworkStats(),
    processAccountStats(),
    getPrice(),
  ]);

  if (DEBUG_TO_CONSOLE) {
    console.log("Helium: Wrote stats to console for debugging");
  } else {
    Influx.write.writePoint(new Point("update").timestamp(processingTime).booleanField('completed', true));
    await Influx.flush();
    console.log('Helium: Influx write success');
  }
}

module.exports = {
  processHelium,
};
