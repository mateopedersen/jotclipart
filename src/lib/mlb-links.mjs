const officialTeams = new Map([
  ['arizona-diamondbacks', 'dbacks'],
  ['athletics', 'athletics'],
  ['atlanta-braves', 'braves'],
  ['baltimore-orioles', 'orioles'],
  ['boston-red-sox', 'redsox'],
  ['chicago-cubs', 'cubs'],
  ['chicago-white-sox', 'whitesox'],
  ['cincinnati-reds', 'reds'],
  ['cleveland-guardians', 'guardians'],
  ['colorado-rockies', 'rockies'],
  ['detroit-tigers', 'tigers'],
  ['houston-astros', 'astros'],
  ['kansas-city-royals', 'royals'],
  ['los-angeles-angels', 'angels'],
  ['los-angeles-dodgers', 'dodgers'],
  ['miami-marlins', 'marlins'],
  ['milwaukee-brewers', 'brewers'],
  ['minnesota-twins', 'twins'],
  ['new-york-mets', 'mets'],
  ['new-york-yankees', 'yankees'],
  ['philadelphia-phillies', 'phillies'],
  ['pittsburgh-pirates', 'pirates'],
  ['san-diego-padres', 'padres'],
  ['san-francisco-giants', 'giants'],
  ['seattle-mariners', 'mariners'],
  ['st-louis-cardinals', 'cardinals'],
  ['tampa-bay-rays', 'rays'],
  ['texas-rangers', 'rangers'],
  ['toronto-blue-jays', 'bluejays'],
  ['washington-nationals', 'nationals'],
]);

/** @param {string} topic */
export function mlbOfficialRoster(topic) {
  const team = officialTeams.get(topic);
  return team ? `https://www.mlb.com/${team}/roster/40-man` : undefined;
}
