// Team identity and divisions verified against https://www.nba.com/teams.
// The official team site is the fallback destination for Charlotte and Denver.
const divisions = [
  [
    ['boston-celtics', 'Boston Celtics', 'team/1610612738/celtics'],
    ['brooklyn-nets', 'Brooklyn Nets', 'team/1610612751/nets'],
    ['new-york-knicks', 'New York Knicks', 'team/1610612752/knicks'],
    ['philadelphia-76ers', 'Philadelphia 76ers', 'team/1610612755/sixers'],
    ['toronto-raptors', 'Toronto Raptors', 'team/1610612761/raptors'],
  ],
  [
    ['chicago-bulls', 'Chicago Bulls', 'team/1610612741/bulls'],
    ['cleveland-cavaliers', 'Cleveland Cavaliers', 'team/1610612739/cavaliers'],
    ['detroit-pistons', 'Detroit Pistons', 'team/1610612765/pistons'],
    ['indiana-pacers', 'Indiana Pacers', 'team/1610612754/pacers'],
    ['milwaukee-bucks', 'Milwaukee Bucks', 'team/1610612749/bucks'],
  ],
  [
    ['atlanta-hawks', 'Atlanta Hawks', 'team/1610612737/hawks'],
    ['charlotte-hornets', 'Charlotte Hornets', 'hornets/'],
    ['miami-heat', 'Miami Heat', 'team/1610612748/heat'],
    ['orlando-magic', 'Orlando Magic', 'team/1610612753/magic'],
    ['washington-wizards', 'Washington Wizards', 'team/1610612764/wizards'],
  ],
  [
    ['denver-nuggets', 'Denver Nuggets', 'nuggets/'],
    ['minnesota-timberwolves', 'Minnesota Timberwolves', 'team/1610612750/timberwolves'],
    ['oklahoma-city-thunder', 'Oklahoma City Thunder', 'team/1610612760/thunder'],
    ['portland-trail-blazers', 'Portland Trail Blazers', 'team/1610612757/blazers'],
    ['utah-jazz', 'Utah Jazz', 'team/1610612762/jazz'],
  ],
  [
    ['golden-state-warriors', 'Golden State Warriors', 'team/1610612744/warriors'],
    ['los-angeles-clippers', 'LA Clippers', 'team/1610612746/clippers'],
    ['los-angeles-lakers', 'Los Angeles Lakers', 'team/1610612747/lakers'],
    ['phoenix-suns', 'Phoenix Suns', 'team/1610612756/suns'],
    ['sacramento-kings', 'Sacramento Kings', 'team/1610612758/kings'],
  ],
  [
    ['dallas-mavericks', 'Dallas Mavericks', 'team/1610612742/mavericks'],
    ['houston-rockets', 'Houston Rockets', 'team/1610612745/rockets'],
    ['memphis-grizzlies', 'Memphis Grizzlies', 'team/1610612763/grizzlies'],
    ['new-orleans-pelicans', 'New Orleans Pelicans', 'team/1610612740/pelicans'],
    ['san-antonio-spurs', 'San Antonio Spurs', 'team/1610612759/spurs'],
  ],
];

const teams = new Map(
  divisions.flatMap((division) =>
    division.map(([slug, name, nbaPath]) => [
      slug,
      {
        name,
        href: `/clipart/${slug}/`,
        officialHref: `https://www.nba.com/${nbaPath}`,
        divisionLinks: division
          .filter(([peer]) => peer !== slug)
          .map(([peer, label]) => ({ name: label, href: `/clipart/${peer}/` })),
      },
    ]),
  ),
);

/** @param {string} topic */
export function nbaLinks(topic) {
  return teams.get(topic);
}
