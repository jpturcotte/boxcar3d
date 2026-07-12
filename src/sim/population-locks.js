// Committed golden locks for the population/fitness contract — measured
// values only, updated ONLY through the deliberate re-lock workflow in
// tests/population-determinism.test.js (set a digest to null, run the gate,
// paste the printed JSON, then Node AND pinned Chromium must agree before
// merge).
//
// LITERALS ONLY, ZERO IMPORTS (the evaluation-locks ruling): the browser
// gate must import the SAME constants Vite serves to Node; importing live
// version constants would auto-track drift and defeat the staleness teeth
// in tests/population-determinism.test.js.
//
// What each lock binds:
//   populationSnapshotDigest       — fnv1a over serializePopulationSnapshot
//                                    (canonical CONTENT: ids + repaired
//                                    genotype bytes) — a PHYSICS-FREE
//                                    initializer/draw-table lock.
//   populationInitializationDigest — fnv1a over the provenance manifest
//                                    (initializer version + seed + resolved
//                                    config + snapshot digest state).
//   evaluationSpecDigest           — fnv1a over the RESOLVED evaluation
//                                    spec (every terrain knob, maxSteps,
//                                    flavor, spawn, drive target, wheel
//                                    friction, termination).
//   fitnessVectorDigest            — fnv1a over the fitness vector (binds
//                                    the snapshot + spec digest states and
//                                    every id/validity/exact-f64 fitness).
//   individuals[]                  — the per-member EXACT literals (JSON
//                                    round-trips f64 bit-exactly): the
//                                    diagnosable form of the vector digest.
//                                    These are measured values, NEVER
//                                    fitness floors — a determinism test
//                                    must not assert fitness magnitudes.
//   champion / championTrace       — deterministic argmax (exact tie ->
//                                    lowest individualId) + its SOLO
//                                    digest-mode rerun at interval 1 (the
//                                    standing isolation sentinel: the rerun
//                                    must reproduce the locked fitness
//                                    exactly under 'isolatedWorlds').
export const POPULATION_GOLDEN_LOCKS = Object.freeze({
  'population-a-initial-composite': Object.freeze({
    fixtureVersion: 1,
    populationSnapshotVersion: 1,
    populationInitializerVersion: 1,
    fitnessPolicyVersion: 1,
    fitnessVectorVersion: 1,
    evaluationSpecVersion: 1,
    genotypeVersion: 1,
    traceVersion: 1,
    recordBytes: 128,
    rapierVersion: '0.19.3',
    effectiveDt: 0.01666666753590107, // Math.fround(1/60) — the engine's f32 timestep readback
    worldMode: 'isolatedWorlds',
    populationSeed: 20260721,
    terrainSeed: 20260722,
    populationSize: 20,
    spawnX: -44,
    maxSteps: 300,
    populationSnapshotDigest: 'cae92db7',
    populationInitializationDigest: '7acb271d',
    evaluationSpecDigest: '1bc14aba',
    fitnessVectorDigest: 'bded0d30',
    orderedIndividualIds: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
    individuals: Object.freeze([
    Object.freeze({ individualId: 0, valid: true, fitness: 1.0603141784667969, stepAtMaxForwardDistance: 300, forwardDistance: 1.0603141784667969, maxBackwardDistance: 0.0081024169921875 }),
    Object.freeze({ individualId: 1, valid: true, fitness: 4.735980987548828, stepAtMaxForwardDistance: 300, forwardDistance: 4.735980987548828, maxBackwardDistance: 0 }),
    Object.freeze({ individualId: 2, valid: true, fitness: 0.042156219482421875, stepAtMaxForwardDistance: 19, forwardDistance: 0.02285003662109375, maxBackwardDistance: 0.000087738037109375 }),
    Object.freeze({ individualId: 3, valid: true, fitness: 1.3441314697265625, stepAtMaxForwardDistance: 300, forwardDistance: 1.3441314697265625, maxBackwardDistance: 0 }),
    Object.freeze({ individualId: 4, valid: true, fitness: 0.000125885009765625, stepAtMaxForwardDistance: 3, forwardDistance: -0.01741790771484375, maxBackwardDistance: 0.017669677734375 }),
    Object.freeze({ individualId: 5, valid: true, fitness: 4.643791198730469, stepAtMaxForwardDistance: 300, forwardDistance: 4.643791198730469, maxBackwardDistance: 0 }),
    Object.freeze({ individualId: 6, valid: true, fitness: 7.176685333251953, stepAtMaxForwardDistance: 300, forwardDistance: 7.176685333251953, maxBackwardDistance: 0.015254974365234375 }),
    Object.freeze({ individualId: 7, valid: true, fitness: 0.004093170166015625, stepAtMaxForwardDistance: 11, forwardDistance: 0.004062652587890625, maxBackwardDistance: 0 }),
    Object.freeze({ individualId: 8, valid: true, fitness: 10.002880096435547, stepAtMaxForwardDistance: 300, forwardDistance: 10.002880096435547, maxBackwardDistance: 0.0002593994140625 }),
    Object.freeze({ individualId: 9, valid: true, fitness: 6.701698303222656, stepAtMaxForwardDistance: 300, forwardDistance: 6.701698303222656, maxBackwardDistance: 0.0000762939453125 }),
    Object.freeze({ individualId: 10, valid: true, fitness: 12.484905242919922, stepAtMaxForwardDistance: 300, forwardDistance: 12.484905242919922, maxBackwardDistance: 0.00008392333984375 }),
    Object.freeze({ individualId: 11, valid: true, fitness: 2.154022216796875, stepAtMaxForwardDistance: 300, forwardDistance: 2.154022216796875, maxBackwardDistance: 0.000286102294921875 }),
    Object.freeze({ individualId: 12, valid: true, fitness: 4.95892333984375, stepAtMaxForwardDistance: 300, forwardDistance: 4.95892333984375, maxBackwardDistance: 0 }),
    Object.freeze({ individualId: 13, valid: true, fitness: 0.0159912109375, stepAtMaxForwardDistance: 134, forwardDistance: 0.0159912109375, maxBackwardDistance: 0.00035858154296875 }),
    Object.freeze({ individualId: 14, valid: true, fitness: 2.3569869995117188, stepAtMaxForwardDistance: 300, forwardDistance: 2.3569869995117188, maxBackwardDistance: 0 }),
    Object.freeze({ individualId: 15, valid: true, fitness: 0.00270843505859375, stepAtMaxForwardDistance: 6, forwardDistance: -0.00016021728515625, maxBackwardDistance: 0.002208709716796875 }),
    Object.freeze({ individualId: 16, valid: true, fitness: 1.4877967834472656, stepAtMaxForwardDistance: 300, forwardDistance: 1.4877967834472656, maxBackwardDistance: 0 }),
    Object.freeze({ individualId: 17, valid: true, fitness: 2.2039833068847656, stepAtMaxForwardDistance: 300, forwardDistance: 2.2039833068847656, maxBackwardDistance: 0.00058746337890625 }),
    Object.freeze({ individualId: 18, valid: true, fitness: 2.441539764404297, stepAtMaxForwardDistance: 300, forwardDistance: 2.441539764404297, maxBackwardDistance: 0.00370025634765625 }),
    Object.freeze({ individualId: 19, valid: true, fitness: 2.9453811645507812, stepAtMaxForwardDistance: 300, forwardDistance: 2.9453811645507812, maxBackwardDistance: 0.00012969970703125 }),
    ]),
    champion: Object.freeze({
      individualId: 10,
      fitness: 12.484905242919922,
      genotypeDigest: '51370bfa',
    }),
    championTrace: Object.freeze({
      digest: 'f5c5f0c7',
      recordCount: 1806,
      byteCount: 231168,
      executedSteps: 300,
      captureCount: 301,
      checkpointStates: Object.freeze([
      988049050, 3196665311, 2346470694, 2429128179, 550786415, 3446781714, 3620520155, 3076473202, 51170112, 2416535274,
      1087348788, 1358939805, 1900584897, 3355041163, 4059563365, 1968401953, 2071566921, 844843475, 1432041831, 2635194187,
      753882186, 3613019500, 1335307328, 1320911339, 1162798763, 3635108000, 1400719197, 1026675345, 1683429840, 3186142477,
      4110068887, 3778821844, 2539557199, 3370918251, 4256784304, 3290801896, 3496093047, 2725922032, 2297584176, 3731132871,
      890380298, 1922964549, 508554191, 3125717746, 3888884381, 4262093794, 3693599795, 2224442831, 3093634300, 3053804640,
      3656125397, 1383012351, 1321193065, 792283193, 2502730112, 2789997546, 3876470919, 3479838032, 2049150596, 1217477124,
      32851183, 134136644, 466013788, 4235138327, 1489399186, 1705400645, 4037920316, 527788742, 463358562, 3203577056,
      2871312840, 4226316078, 3417981613, 2547246872, 1641489730, 830147096, 2099439802, 1313766521, 1722309635, 378138043,
      288497156, 3830408081, 4174965542, 3444447419, 1281531073, 2851247098, 3877022367, 2137974493, 1017670914, 679536540,
      1308660236, 2531207857, 1602590512, 185138348, 4016914162, 2011767058, 1089723337, 2971201924, 2171231830, 1723942619,
      3075081907, 3555703453, 1577774454, 1923175916, 2175869292, 723865492, 2423492348, 4002222485, 1113206738, 432286146,
      2644223748, 1697488668, 58782037, 2824246877, 224137011, 2499779518, 1296991833, 1625452417, 2659456586, 230092342,
      4184602622, 2509218130, 2387743306, 3992924586, 2304794820, 1620749879, 120876785, 2683671325, 3853961680, 1261607475,
      4054446442, 3068284989, 3458196863, 1551301172, 363211768, 838453473, 2693537976, 574560745, 3791617159, 3454166493,
      1623085096, 1062816314, 1047713890, 1810427777, 2498298108, 3950002137, 3196590486, 578093877, 2216518940, 3059354753,
      2452560597, 2117144848, 2721664850, 3577779454, 740366491, 3638187907, 2236332610, 3934794325, 4182005041, 1314565168,
      2073814673, 1259950839, 3677241054, 4112940650, 3770671791, 1359582613, 2670513568, 844478485, 61885158, 3066771463,
      914987567, 1641187813, 2212913280, 3766473452, 4035912348, 2449213519, 3452446756, 2809972551, 390571239, 3827178991,
      2653790344, 3127638459, 3861897336, 3208795654, 1295466395, 1739232525, 2806229327, 1040710400, 2533171173, 3563955488,
      2830493401, 1753225003, 4074005655, 677439902, 2695658387, 2550584720, 4232222123, 2524881455, 1325700113, 956535941,
      3987620527, 1537314492, 1724561004, 2833774603, 1265045221, 2997249395, 4135431695, 1132201100, 1543688780, 673694474,
      1487963861, 3662326989, 751293890, 635252209, 2735706657, 2046981174, 139387643, 1923101067, 2775256808, 1573724425,
      3636865333, 2970099705, 2196142785, 3493892959, 3223011970, 733020869, 3035375791, 3673998533, 1003762923, 3675633214,
      1427023468, 1807431808, 2722655366, 565004752, 3669403446, 3968068941, 3388428661, 2221284705, 769718111, 3674424379,
      1606652633, 2608552192, 1338104100, 559517208, 3426003306, 1337566463, 3332653415, 1020554177, 1950224956, 4161828956,
      1751338167, 2606450571, 4159233339, 1001245882, 1433603075, 1882470543, 4211325061, 1894158766, 1470628020, 178199532,
      3280249475, 3562721776, 3218655114, 3981138362, 4202995184, 4068159171, 3594211803, 1094368302, 3148582727, 1765859793,
      2438710558, 3904134354, 815739625, 3647211398, 964443410, 1030752277, 3034330708, 3336579827, 523384115, 1068226254,
      2650808359, 565792226, 769542470, 103425415, 3655024833, 1401442182, 4066749387, 968872129, 3694582328, 710688461,
      2033370204, 3677406966, 1665848109, 2484769397, 383471596, 3488454828, 4012455210, 2269503128, 910691332, 51588771,
      4123390151,
      ]),
    }),
  }),
});
