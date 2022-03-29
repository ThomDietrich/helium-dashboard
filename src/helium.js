const { DateTime } = require('luxon');
const { Client, RewardsV1, RewardsV2, PocReceiptsV1, Challenge} = require('@helium/http');
const { Influx, Point } = require('./influx');
const { default: axios } = require('axios');

// number of hours to go back to fetch hotspot activity
const ACTIVITY_LOOKBACK_HOURS = process.env.HELIUM_ACTIVITY_LOOKBACK_HOURS ? process.env.HELIUM_ACTIVITY_LOOKBACK_HOURS : 4;
const DEBUG_TO_CONSOLE = process.env.DEBUG_TO_CONSOLE ? true : false;

const processingTime = new Date(); // now
const helium = new Client();

const activityType = {
  rewards_v2: 'rewards',
  poc_receipts_v1: 'witnessed',
  poc_request_v1: 'challenge',
  state_channel_close_v1: 'data_transfer'
}

async function getPrice() {
  const response = await axios('https://api.coingecko.com/api/v3/simple/price?ids=helium&vs_currencies=USD,EUR');

  let point = new Point("helium_price")
  point.timestamp(processingTime);
  point.tag('source', 'CoinGecko');

  point.floatField('usd', response.data.helium.usd);
  point.floatField('eur', response.data.helium.eur);

  if (DEBUG_TO_CONSOLE) {
    console.log(point)
  } else {
    Influx.write.writePoint(point);
  }
}

async function processAccountStats() {
  let data = await helium.accounts.get(process.env.HELIUM_WALLET);

  let point = new Point("helium_account")
    .timestamp(processingTime)
    .tag('account', data.address)
  ;

  point.floatField('balance_hnt', data.balance.floatBalance);
  point.floatField('balance_staked_hnt', data.stakedBalance.floatBalance);
  point.floatField('balance_sec_hst', data.secBalance.floatBalance);
  point.floatField('balance_dc_dc', data.dcBalance.floatBalance);

  if (DEBUG_TO_CONSOLE) {
    console.log(point)
  } else {
    Influx.write.writePoint(point);
  }
}

async function processHotspotActivity(hotspotIdentifier, sinceDate) {
  let activities = [];
  let oldestTime = DateTime.now;
  let hotspot = await helium.hotspots.get(hotspotIdentifier);
  let hotspotName = hotspot.name.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
  let hotspotGeotext = hotspot.geocode.shortCity + ", " + hotspot.geocode.shortStreet;

  console.log(`Helium: fetching activities for ${hotspotName} since ${sinceDate.toString()}`);

  let point = new Point("helium_hotspot")
    .timestamp(processingTime)
    .tag('hotspot_id', hotspotIdentifier)
    .tag('hotspot_name', hotspotName)
    .tag('geotext', hotspotGeotext)
    .tag('latitude', hotspot.lat)
    .tag('longitude', hotspot.lon)
    .tag('mode', hotspot.mode)
  ;

  point.floatField('reward_scale', hotspot.reward_scale);

  if (hotspot.score) {
    point.floatField('score', hotspot.score);
  }
  if (hotspot.scoreUpdateHeight) {
    point.floatField('scoreUpdateHeight', hotspot.scoreUpdateHeight);
  }

  if (DEBUG_TO_CONSOLE) {
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

  console.log(`Helium: fetched ${activities.length} activities for ${hotspotName} (first ${DateTime.fromSeconds(activities[activities.length-1].time).toString()})`);
  // activities.map(act => console.log(DateTime.fromSeconds(act.time).toString()));

  // convert activities to Influx points
  const points = activities.map(act => {
    const point = new Point('helium_activity')
      .timestamp(DateTime.fromSeconds(act.time).toJSDate())
      .tag('hotspot_id', hotspotIdentifier)
      .tag('hotspot_name', hotspotName)
      .tag('geotext', hotspotGeotext)
    ;

    if (act instanceof RewardsV1) {
      // Links to "Received Mining Reward"
      if (act.rewards.length == 1) {
        reward_type = act.rewards[0].type
        let reward_type_explorer = (reward_type == 'poc_witnesses') ? 'witness' : (
          (reward_type == 'poc_challengers') ? 'challenger' : (
            (reward_type == 'poc_challengees') ? 'beacon' : 'unknown'
          )
        )
        point.tag('type_poc', reward_type);
        point.tag('type_explorer', reward_type_explorer);
      } else {
        console.log(act.rewards)
        point.tag('type_poc', 'misc');
        point.tag('type_explorer', 'misc');
      }
      point.floatField('reward', act.totalAmount.floatBalance);

    } else if (act.type == 'poc_receipts_v1') {
      if (act.path[0].challengee == hotspotIdentifier) {
        // Links to "Broadcast Beacon"
        //   Field count: Events of beacons broadcasted
        //   Field witnesses: Number of witnesses of the hotspot's beacon
        point.tag('type', 'broadcast_beacon');
        point.intField('count', 1);
        point.intField('witnesses', act.path[0].witnesses.length);
      } else {
        // Explorer: Links to "Challenged Beaconer"
        //   Field count: Events of challenges sent
        point.tag('type', 'challenged_beaconer');
        point.tag('result', act.path[0].result);
        point.intField('count', 1);
      }

    } else if (act.type == 'poc_request_v1') {
      // Explorer: Links to "Constructed Challenge"
      point.tag('type', 'constructed_challenge');
      point.intField('count', 1);

    } else if (act.type == 'state_channel_close_v1') {
      point.tag('type', 'data_transfer');
      point.intField('packets', act.stateChannel.summaries[0].num_packets);
      point.intField('dc', act.stateChannel.summaries[0].num_dcs);

    } else {
      console.log('Invalid type: ', act.type);
      console.log(act);
      return new Point('helium_activity');  // return blank point
    }

    return point;
  });

  if (DEBUG_TO_CONSOLE) {
    console.log(points)
  } else {
    Influx.write.writePoint(points);
  }
}

async function processHeliumStats() {
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
    processHeliumStats(),
    processAccountStats(),
    getPrice(),
  ]);

  if (DEBUG_TO_CONSOLE) {
    console.log("Helium: Wrote stats to console for debugging");
  } else {
    await Influx.flush();
    console.log('Helium: Influx write success');
  }
}

module.exports = {
  processHelium,
};
