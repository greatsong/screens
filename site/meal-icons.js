/* 급식 메뉴 이름 → 음식 그림 열쇠(site/meal/<열쇠>.webp).
 * 화면(app.js)과 휴대폰 투표 페이지(vote.html)가 함께 쓴다. 그림은 Codex 이미지 생성으로 만든 애니메이션풍(site/meal/README.md) */
(function () {
  // 위에서부터 먼저 맞는 것을 쓴다(볶음밥은 밥보다, 국은 그 안의 재료보다 먼저). 맞는 것이 없으면 dish(급식 식판)
  const MEAL_ICON = [
    [/케이크/, 'cake'], [/아이스크림|빙수|샤베트/, 'icecream'], [/요거트|요구르트/, 'yogurt'], [/우유|두유/, 'milk'], [/주스|에이드|스무디|식혜|음료/, 'juice'],
    [/김밥|주먹밥/, 'kimbap'], [/초밥/, 'sushi'], [/카레/, 'curry'], [/볶음밥|오므라이스/, 'friedrice'], [/스파게티|파스타|그라탕/, 'pasta'],
    [/짜장/, 'jjajang'], [/짬뽕|라면|국수|우동|냉면|쫄면|소바|면$/, 'noodle'], [/피자/, 'pizza'], [/햄버거|버거/, 'burger'], [/핫도그|소시지|소세지/, 'hotdog'],
    [/샌드위치/, 'sandwich'], [/타코/, 'taco'], [/부리또|또띠아/, 'burrito'], [/떡볶이/, 'tteokbokki'], [/어묵|오뎅/, 'fishcake'],
    [/만두/, 'dumpling'], [/치킨|닭|윙|너겟|텐더/, 'chicken'], [/새우|깐쇼/, 'shrimp'], [/오징어|낙지|쭈꾸미|주꾸미|문어/, 'squid'],
    [/생선|고등어|삼치|갈치|연어|동태|명태|참치|꽁치|가자미|코다리/, 'fish'], [/국$|장국|스프|수프/, 'soup'], [/찌개|전골|탕$/, 'stew'], [/돈가스|돈까스|커틀릿/, 'cutlet'],
    [/스테이크|함박|불고기|갈비|제육|돈육|쇠고기|소고기|고기|수육|보쌈|족발|목살|삼겹/, 'meat'], [/호떡|와플|팬케이크/, 'hotteok'], [/떡/, 'tteok'],
    [/완자전|동그랑땡|전$|부침/, 'jeon'], [/도넛/, 'donut'], [/빵|토스트|베이글|크로와상|머핀|파이/, 'bread'], [/쿠키|초코|브라우니|마카롱/, 'cookie'],
    [/김치|깍두기|겉절이|석박지|섞박지/, 'kimchi'], [/샐러드/, 'salad'], [/브로콜리/, 'broccoli'], [/단호박/, 'pumpkin'], [/애호박|오이/, 'zucchini'],
    [/감자/, 'potato'], [/고구마/, 'sweetpotato'], [/옥수수/, 'corn'], [/당근/, 'carrot'], [/버섯|팽이/, 'mushroom'], [/치즈/, 'cheese'],
    [/계란|달걀|에그/, 'egg'], [/나물|무침|쌈|생채/, 'namul'], [/사과/, 'apple'], [/^배$/, 'pear'], [/귤|오렌지|한라봉|천혜향/, 'tangerine'],
    [/바나나/, 'banana'], [/포도|샤인머스캣/, 'grape'], [/수박/, 'watermelon'], [/딸기/, 'strawberry'], [/복숭아/, 'peach'],
    [/파인애플/, 'pineapple'], [/키위/, 'kiwi'], [/망고/, 'mango'], [/체리/, 'cherry'], [/멜론/, 'melon'], [/레몬/, 'lemon'],
    [/밥$|라이스/, 'rice'], [/묵|두부|조림|볶음|구이|찜/, 'side']
  ];
  // 제목·하루 칸에 붙일 주요리: 한 그릇 요리가 있으면 그것, 없으면 고기·생선 반찬, 그다음 찌개(밥·국·김치는 고르지 않는다)
  const MAIN = ['pizza', 'burger', 'curry', 'pasta', 'jjajang', 'noodle', 'friedrice', 'kimbap', 'tteokbokki', 'chicken', 'cutlet', 'meat',
    'shrimp', 'squid', 'fish', 'dumpling', 'hotdog', 'stew'];
  // 후식·특식: 칸 테두리를 강조색으로 두르고 반짝이를 지나가게 한다
  const TREAT = ['cake', 'icecream', 'yogurt', 'juice', 'pizza', 'burger', 'chicken', 'tteokbokki', 'hotteok', 'donut', 'cookie', 'apple', 'pear',
    'tangerine', 'banana', 'grape', 'watermelon', 'strawberry', 'peach', 'pineapple', 'kiwi', 'mango', 'cherry', 'melon'];
  const icon = (name) => { for (const [re, k] of MEAL_ICON) if (re.test(name)) return k; return 'dish'; };
  window.MEAL = {
    icon: icon,
    main(dishes) { const ks = dishes.map(icon); for (const k of MAIN) if (ks.indexOf(k) >= 0) return k; return 'rice'; },
    treat(name) { return TREAT.indexOf(icon(name)) >= 0; },
  };
})();
