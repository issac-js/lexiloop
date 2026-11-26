/** Reviewed English practice examples. Cases and identifying details are fictional. */
export const workplaceTopics = [
  {
    id: 'traffic',
    title: '交通纠纷',
    subtitle: '两车碰撞、伤情、责任',
    keywords: '交通事故 剐蹭 追尾 受伤 伤情 责任 traffic accident collision injury injured liability fault',
    intake: [
      ['有人受伤吗？', 'Is anyone injured?'],
      ['确认事发地点', 'Could you tell me exactly where the collision happened?'],
      ['你亲眼看到碰撞了吗？', 'Did you see the collision yourself?'],
    ],
    handover: [
      ['截至目前，未收到受伤报告', 'No injuries have been reported so far.'],
      ['事故责任尚未认定', 'Liability has not yet been determined.'],
    ],
    report: [
      'At 4:20 p.m., a driver reported a minor [[collision]] near the east gate. He said another vehicle had backed into his car. The other driver [[gave a different account|different account]] and said his vehicle had been stationary. Neither driver reported an [[injury]] during the call. A staff member later confirmed that both vehicles had visible damage.',
      'We [[recorded their contact details|contact details]] and noted that a person nearby might have witnessed the incident. We have yet to confirm what that person saw. The two accounts are recorded separately in the incident log. [[Liability|liability]] has not yet been determined.',
    ],
    translation: [
      '下午 4:20，一名驾驶员报告东门附近发生轻微碰撞。他说另一辆车倒车撞到了他的车。另一名司机说法不同，称自己的车当时处于静止状态。通话期间，双方均未报告受伤。工作人员随后确认两辆车均有可见损伤。',
      '我们记录了双方的联系方式，并注明附近可能有人目击。我们尚未确认该人看到了什么。双方的陈述已分别记入事件记录，责任尚未认定。',
    ],
    expressions: {
      collision: ['collision', '碰撞', 'report a minor collision', 'collision'],
      'different account': ['give a different account', '给出不同的陈述', '交班时可以用它交代双方说法不同。'],
      injury: ['injury / injured', '受伤、伤害 / 受伤的', 'report an injury · No injuries have been reported so far.', 'injury'],
      'contact details': ['record contact details', '记录联系方式', 'Could I take your name and a number to reach you on?', 'contact details'],
      liability: ['liability', '依法承担的责任', 'determine liability · Who was at fault? 常用于口头询问谁有过错。', 'liability'],
    },
    exercise: {
      cue: '停车场有人报告车门受损。他没有看到碰撞，也没有报告受伤。用两句英文交班，说明情况来源和目前掌握的信息。',
      answer: 'A driver reported damage to his car door in the parking lot. He did not see the collision, and no injuries were reported during the call.',
    },
  },
  {
    id: 'payment',
    title: '经济纠纷',
    subtitle: '付款记录、退款、待确认金额',
    keywords: '经济纠纷 付款 退款 转账 交易记录 reference payment refund dispute',
    intake: [
      ['确认付款时间和金额', 'Could you confirm when you made the payment and how much you paid?'],
      ['询问交易编号', 'Do you have a transaction reference I can note down?'],
    ],
    handover: [
      ['一方称已转账', 'One party said they had already made the transfer.'],
      ['收款情况仍待确认', 'We have yet to confirm whether the payment was received.'],
    ],
    report: [
      'A student called about a [[payment dispute]]. She said she had [[made a bank transfer|bank transfer]] for a deposit on Monday, but the recipient said the money had not arrived. The student provided the amount and a [[transaction reference]]. The record she showed us listed the transfer as pending.',
      'We logged both accounts and recorded the amount in dispute. We have yet to [[confirm whether]] the payment was received. The student also asked whether she could request a [[refund]] if the recipient later confirmed that the money had arrived. We recorded that question separately for follow-up.',
    ],
    translation: [
      '一名学生来电反映付款纠纷。她说周一已通过银行转账支付押金，但收款方称款项未到账。学生提供了金额和交易编号。她出示的记录显示转账仍在处理中。',
      '我们登记了双方的说法及争议金额。目前尚未确认款项是否到账。学生还问，如果收款方之后确认收到款项，她能否申请退款。我们单独记下了这个问题，以便跟进。',
    ],
    expressions: {
      'payment dispute': ['payment dispute', '付款纠纷', 'a dispute over a deposit · a refund dispute'],
      'bank transfer': ['make a bank transfer', '通过银行转账', '另一个常用说法是 pay by bank transfer。'],
      'transaction reference': ['transaction reference', '交易编号', '可询问客户用于识别该笔交易的编号。'],
      'confirm whether': ['confirm whether', '确认是否', 'confirm whether the payment was received', 'confirm whether'],
      refund: ['refund', '退款', 'request a refund · receive a refund', 'refund'],
    },
    exercise: {
      cue: '一人称周二已付款，收款方称未收到。你只有交易编号，没有到账确认。用英文写两句交班。',
      answer: 'One party said they had paid on Tuesday and provided a transaction reference. We have yet to confirm whether the recipient received the payment.',
    },
  },
  {
    id: 'drone',
    title: '无人机',
    subtitle: '目击时间、位置、飞行方向',
    keywords: '无人机 飞行 目击 影像 drone sighting flying footage direction',
    intake: [
      ['确认观察位置和时间', 'Where were you when you saw the drone, and when was that?'],
      ['确认是否仍能看到', 'Can you still see the drone from where you are?'],
    ],
    handover: [
      ['有来电人报告看到无人机', 'A caller reported seeing a drone near the library.'],
      ['操作者尚未确认', 'We have yet to identify the operator.'],
    ],
    report: [
      'At 6:10 p.m., a caller [[reported seeing a drone|drone]] near the library. She said she had seen it from the courtyard and that it appeared to be moving toward the sports field. She could no longer see it by the end of the call. We noted the [[time of the sighting|sighting]] and where she had been standing.',
      'A second caller said he had a short video of the object. We recorded that information as a separate report. The [[footage]] had yet to be reviewed, and we had not [[identified the operator|operator]] at the time of the handover.',
    ],
    translation: [
      '晚上 6:10，一名来电人报告在图书馆附近看到无人机。她说自己是从庭院里看到的，无人机似乎正朝运动场方向飞去。通话结束时，她已看不到它。我们记下了目击时间和她当时所在的位置。',
      '第二名来电人称拍下了该物体的一段短视频。我们将这条信息作为单独报告记录。交班时，视频尚待查看，操作者也未确认。',
    ],
    expressions: {
      drone: ['drone', '无人机', 'report seeing a drone · a drone sighting', 'drone'],
      sighting: ['time of the sighting', '目击时间', '可并列记录 the location of the sighting。'],
      footage: ['review the footage', '查看影像', 'footage 在这里通常作不可数名词。', 'footage'],
      operator: ['identify the operator', '确认操作者身份', 'We have yet to identify the operator.', 'operator'],
    },
    exercise: {
      cue: '来电人称在宿舍楼附近看到无人机，但通话时已经看不到了。用两句英文交班。把目击来源交代清楚。',
      answer: 'A caller reported seeing a drone near the residence hall. They could no longer see it when they called.',
    },
  },
  {
    id: 'missing',
    title: '人员失踪',
    subtitle: '失联、最后见面和联系时间',
    keywords: '人员失踪 失联 下落 最后见到 missing person last seen reach contact whereabouts',
    intake: [
      ['最后一次见到对方', 'When and where did you last see them?'],
      ['最后一次联系', 'When did you last hear from them?'],
    ],
    handover: [
      ['来电人表示联系不上对方', 'The caller said they had been unable to reach the student.'],
      ['记录下落仍未知', 'The student’s current whereabouts are unknown.'],
    ],
    report: [
      'At 8:15 p.m., a student called about a friend she had [[been unable to reach|reach]]. She said she had [[last seen|last seen]] him near the library at 5:30 p.m. and had received a message from him about an hour later. She had not [[heard from him|hear from]] since then. We recorded the time of the last sighting separately from the time of the last message.',
      'The caller gave us a number where she could be reached for [[follow-up questions|follow-up]]. At the time of the handover, the student’s current [[whereabouts]] were unknown. The incident log attributed the reported times and locations to the caller.',
    ],
    translation: [
      '晚上 8:15，一名学生来电称联系不上一位朋友。她说最后一次见到他是在下午 5:30，地点在图书馆附近。大约一小时后，她收到过他发来的消息，此后再未收到消息。我们分开记录了最后见面的时间与最后收到消息的时间。',
      '来电人留下了便于后续联系的号码。交班时，尚不清楚该学生目前在哪里。事件记录注明，相关时间和地点均由来电人提供。',
    ],
    expressions: {
      reach: ['be unable to reach someone', '暂时联系不上某人', 'The caller said they had been unable to reach the student.', 'reach'],
      'last seen': ['when and where someone was last seen', '最后一次见到某人的时间和地点', 'When and where did you last see them?'],
      'hear from': ['last hear from someone', '最后一次收到某人的消息', 'When did you last hear from them?'],
      'follow-up': ['follow-up questions', '后续询问', '名词作定语可用 follow-up。作动词可说 follow up with the caller。'],
      whereabouts: ['current whereabouts', '目前的下落', 'Their current whereabouts are unknown.', 'whereabouts'],
    },
    exercise: {
      cue: '来电人 17:30 在食堂见过对方，19:00 收到对方的短信，此后没有消息。用两句英文交班，分清见面和联系。',
      answer: 'The caller said they last saw the student in the cafeteria at 5:30 p.m. They last heard from the student by text at 7 p.m.',
    },
  },
]
