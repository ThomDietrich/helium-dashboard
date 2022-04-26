const { DateTime } = require('luxon');
const { Client, RewardsV1, UnknownTransaction, Network} = require('@helium/http');
const { Influx, Point } = require('./influx');
const { default: axios } = require('axios');

// number of hours to go back to fetch hotspot activity
const ACTIVITY_LOOKBACK_HOURS = process.env.HELIUM_ACTIVITY_LOOKBACK_HOURS ? process.env.HELIUM_ACTIVITY_LOOKBACK_HOURS : 4;
const DEBUG_TO_CONSOLE = process.env.DEBUG_TO_CONSOLE ? true : false;

const processingTime = new Date(); // now
const helium_client = new Client(Network.production, { retry: 100 });

async function getPrice() {
  console.log('Helium: collecting price data');
  const response = await axios('https://api.coingecko.com/api/v3/simple/price?ids=helium&vs_currencies=USD,EUR');

  let point = new Point("helium_price")
  point.timestamp(processingTime);
  point.tag('source', 'CoinGecko');

  point.floatField('usd', response.data.helium.usd);
  point.floatField('eur', response.data.helium.eur);

  if (DEBUG_TO_CONSOLE) {
    console.log("\n=== Price " + "=".repeat(100));
    console.log(response)
    console.log()
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
    console.log(data)
    console.log()
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

  console.log(`Helium: collecting activities for ${hotspotName} since ${sinceDate.toString()}`);

  let point = new Point("helium_hotspot")
    .timestamp(processingTime)
    .tag('hotspot_id', hotspotIdentifier)
    .tag('hotspot_name', hotspotName)
    .tag('geotext', hotspotGeotext)
    .tag('latitude', hotspot.lat)
    .tag('longitude', hotspot.lng)
  ;

  if (hotspot.rewardScale) {
    point.floatField('reward_scale', hotspot.rewardScale);
  }
  point.intField('block_last_change', hotspot.lastChangeBlock);

  if (DEBUG_TO_CONSOLE) {
    console.log("\n=== Hotspot Stats " + "=".repeat(100));
    console.log(hotspot)
    console.log()
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
    console.log(`Helium: -> no activities for ${hotspotName} since ${sinceDate.toString()}`);
    return;
  }

  // convert activities to Influx points
  const points = activities.map(act => {
    if (DEBUG_TO_CONSOLE) {
      console.log("\n--- Hotspot Activity " + "-".repeat(60));
      console.log(act);
    }

    const point = new Point('helium_activity')
      .timestamp(DateTime.fromSeconds(act.time).toJSDate())
      .tag('hotspot_id', hotspotIdentifier)
      .tag('hotspot_name', hotspotName)
    ;
    point.booleanField('event', true);

    // Proof of Coverage activities

    if (act.type == 'poc_receipts_v1' && act.challenger == hotspotIdentifier) {
      // "Challenged Beaconer"
      point.tag('poc_role', 'challenged_beaconer');
      point.tag('poc_result', act.path[0].result);
      point.intField('witnesses', act.path[0].witnesses.length);

    } else if (act.type == 'poc_receipts_v1' && act.path[0].challengee == hotspotIdentifier) {
      // "Broadcast Beacon"
      point.tag('poc_role', 'broadcast_beacon');
      point.tag('poc_result', act.path[0].result);
      point.intField('witnesses', act.path[0].witnesses.length);

    } else if (act.type == 'poc_receipts_v1' && act.path[0].witnesses.some(w => w.gateway == hotspotIdentifier)) {
      // "Witnessed Beacon"
      point.tag('poc_role', 'witnessed_beacon');
      point.tag('poc_result', act.path[0].result);
      point.tag('beaconer', act.path[0].challengee);
      point.intField('witnesses', act.path[0].witnesses.length);

    } else if (act.type == 'poc_request_v1' && act.challenger == hotspotIdentifier) {
      // "Constructed Challenge"
      point.tag('poc_role', 'constructed_challenge');

    // Rewards activities

    } else if (act instanceof RewardsV1 && act.type == 'rewards_v2') {
      // "Received Mining Reward"
      point.measurement('helium_reward')
      if (act.rewards.length == 1) {
        reward_type = act.rewards[0].type
        let reward_type_explorer = (reward_type == 'poc_witnesses') ? 'witness' : (
          (reward_type == 'poc_challengers') ? 'challenger' : (
            (reward_type == 'poc_challengees') ? 'beacon' : (
              (reward_type == 'data_credits') ? 'data' : 'unknown'
            )
          )
        )
        if (reward_type_explorer == 'unknown') {
          console.log("Reward type unknown, skipping:");
          console.log(act);
          return
        }
        point.tag('reward_type_poc', reward_type);
        point.tag('reward_type_explorer', reward_type_explorer);
      } else {
        //console.log("Multiple reward types encounted:\n" + act.rewards)
        point.tag('reward_type_poc', 'mixed');
        point.tag('reward_type_explorer', 'mixed');
      }
      point.floatField('reward_hnt', act.totalAmount.floatBalance);

    // Data Transfer activities

    } else if (act.type == 'state_channel_close_v1') {
      // "Data Transfer"
      point.measurement('helium_data_transfer')
      point.intField('packets', act.stateChannel.summaries[0].numPackets);
      point.intField('dcs', act.stateChannel.summaries[0].numDcs);

    // Unknown activities (to be implemented)

    } else {
      point.measurement('helium_activity_unknown')
      console.log("Unknown activity encountered (Ignore AddGatewayV1 and AssertLocationV2):")
      console.log(act)
    }

    if (DEBUG_TO_CONSOLE) {
      console.log()
      console.log(point);
    }
    return point;
  });

  console.log(`Helium: -> fetched ${activities.length} activities for ${hotspotName} (first ${DateTime.fromSeconds(activities[activities.length-1].time).toString()})`);

  if (!DEBUG_TO_CONSOLE) {
    Influx.write.writePoints(points);
  }
}

async function processNetworkStats() {
  console.log('Helium: collecting network stats');
  const data = await helium_client.stats.get()

  let point = new Point("helium_stats")
    .timestamp(processingTime)
  ;

  point.intField('transactions', data.counts.transactions);
  point.intField('challenges', data.counts.challenges);
  point.intField('blocks', data.counts.blocks);

  point.intField('hotspots_registered', data.counts.hotspots);
  point.intField('hotspots_online', data.counts.hotspotsOnline);
  point.intField('hotspots_dataonly', data.counts.hotspotsDataonly);

  point.intField('challenges_active', data.challengeCounts.active);
  point.floatField('blocktime_lasthour_sec', data.blockTimes.lastHour.avg);

  if (DEBUG_TO_CONSOLE) {
    console.log("\n=== Network Stats " + "=".repeat(100));
    console.log(data)
    console.log()
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

  if (!DEBUG_TO_CONSOLE) {
    Influx.write.writePoint(new Point("update").timestamp(processingTime).booleanField('processing', true));
    await Influx.flush();
  }

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
