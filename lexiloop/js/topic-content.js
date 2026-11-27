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
      'At 4:20 p.m., a driver reported a minor [[collision]] near the east gate. He said he had been [[involved in a rear-end collision|rear-end]] and that the other car had struck his from behind. The other driver [[gave a different account|different account]] and said his own vehicle had been stationary. Neither driver [[reported any injuries|injury]] during the call. A staff member later confirmed that both vehicles had visible damage.',
      'We [[recorded their contact details|contact details]] and noted that a person nearby [[might have witnessed the incident|witness]]. We have yet to confirm what that person saw. We recorded the drivers’ accounts separately in the incident log. [[Liability|liability]] has not yet been determined.',
    ],
    translation: [
      '下午 4:20，一名驾驶员报告东门附近发生轻微碰撞。他说发生了追尾，对方的车从后方撞上了自己的车。另一名司机说法不同，称自己的车当时处于静止状态。通话期间，双方均未报告受伤。工作人员随后确认两辆车均有可见损伤。',
      '我们记录了双方的联系方式，并注明附近可能有人目击。我们尚未确认该人看到了什么。双方的陈述已分别记入事件记录，责任尚未认定。',
    ],
    expressions: {
      collision: ['collision', '碰撞', 'report a minor collision', 'collision'],
      'rear-end': ['be involved in a rear-end collision', '卷入一起追尾事故', '这个搭配可描述事故类型，具体责任另行确认。', 'rear-end'],
      'different account': ['give a different account', '说法不同', '可交代陈述有出入，再分别说明各自怎么说。', 'give a different account'],
      injury: ['report any injuries', '报告是否有人受伤', 'Neither driver reported any injuries. 两名司机都未报告受伤。', ['injury', 'any injuries']],
      'contact details': ['record contact details', '记录联系方式', 'Could I get your name and a number where we can reach you?', 'contact details'],
      witness: ['witness the incident', '目击事件', '亲眼看到可说 witness the incident。尚未确认时可说 might have witnessed it。', 'witness'],
      liability: ['liability', '依法承担的责任', 'determine liability · Who was at fault? 常用于口头询问谁有过错。', 'liability'],
    },
    exercise: {
      cue: '停车场有人报告车门受损。他没有看到碰撞，也没有报告受伤。用两句英文交班，说明情况来源和目前掌握的信息。',
      answer: 'A driver reported damage to his car door in the parking lot. He said he did not see a collision and did not report any injuries during the call.',
      check: '交代谁报告了车损，并把未目击碰撞和未收到伤情报告分别写清。',
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
      ['询问付款凭证', 'Do you have a receipt or other proof of payment?'],
    ],
    handover: [
      ['一方称已转账', 'One party said they had already made the transfer.'],
      ['收款情况仍待确认', 'We have yet to confirm whether the payment was received.'],
    ],
    report: [
      'A student called about a [[payment dispute]]. She said she had used a [[bank transfer]] to [[pay a security deposit|security deposit]] on Monday, but the recipient said the money had not arrived. The student provided the amount and a [[transaction reference]]. She also shared a screenshot as [[proof of payment]], but it showed that the transfer was still pending.',
      'We logged both accounts and recorded the amount in dispute. We have yet to [[confirm whether]] the payment was received. The student asked whether she could [[request a partial refund|refund]] if the recipient later confirmed receipt of the payment. We recorded that question separately for follow-up.',
    ],
    translation: [
      '一名学生来电反映付款纠纷。她说周一已通过银行转账支付押金，但收款方称款项未到账。学生提供了金额和交易编号，也出示了截图作为付款凭证，但截图显示转账仍在处理中。',
      '我们登记了双方的说法及争议金额。目前尚未确认款项是否到账。学生还问，如果收款方之后确认收到款项，她能否申请部分退款。我们单独记下了这个问题，以便跟进。',
    ],
    expressions: {
      'payment dispute': ['payment dispute', '付款纠纷', '押金纠纷可说 a dispute over a deposit。', ['payment dispute', 'dispute']],
      'bank transfer': ['make a bank transfer', '通过银行转账', '另一个常用说法是 pay by bank transfer。', 'bank transfer'],
      'security deposit': ['pay a security deposit', '缴纳押金', '口头也可说 put down a security deposit。', 'security deposit'],
      'transaction reference': ['transaction reference', '交易编号', '可询问对方用于识别该笔交易的编号。', 'transaction reference'],
      'proof of payment': ['proof of payment', '付款凭证', '看到截图后，记录显示的状态，例如 pending（处理中）。', 'proof of payment'],
      'confirm whether': ['confirm whether', '确认是否', 'confirm whether the payment was received', ['confirm whether', 'confirm']],
      refund: ['request a partial refund', '申请部分退款', '部分退款用 partial refund，全额退款用 full refund。', ['refund', 'partial']],
    },
    exercise: {
      cue: '一人称周二已付款，收款方称未收到。你只有交易编号，没有到账确认。用英文写两句交班。',
      answer: 'One party said they had paid on Tuesday and gave us a transaction reference. The recipient said the money had not come through, and we have yet to confirm whether it was received.',
      check: '写出付款方和收款方各自怎么说，并说明到账情况还待确认。',
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
      ['确认最后看到的飞行方向', 'Which way was it moving when you last saw it?'],
    ],
    handover: [
      ['有来电人报告看到无人机', 'A caller reported seeing a drone near the library.'],
      ['操作者尚未确认', 'We have yet to identify the operator.'],
      ['正在核查无人机报告', 'We are looking into the report.'],
    ],
    report: [
      'At 6:10 p.m., a caller [[reported seeing a drone|drone]] near the library. She said she had seen it from the courtyard and that it appeared to be moving toward the sports field. She could no longer see it by the end of the call. We noted the [[time of the sighting|sighting]], where she had been standing, and the reported [[direction of travel]].',
      'A second caller said he had a short video of the object. We logged that report separately and asked a staff member to [[review surveillance footage|footage]] from the area. At handover, the staff member had yet to review the footage, and we had not [[identified the operator|operator]].',
    ],
    translation: [
      '晚上 6:10，一名来电人报告在图书馆附近看到无人机。她说自己是从庭院里看到的，无人机似乎正朝运动场方向飞去。通话结束时，她已看不到它。我们记下了目击时间、她当时所在的位置，以及她描述的飞行方向。',
      '第二名来电人称拍下了该物体的一段短视频。我们将其单独记录，并请工作人员查看该区域的监控影像。交班时，监控影像尚待查看，操作者也未确认。',
    ],
    expressions: {
      drone: ['drone', '无人机', 'report seeing a drone · a drone sighting', 'drone'],
      sighting: ['time of the sighting', '目击时间', '可并列记录 the location of the sighting。', 'sighting'],
      'direction of travel': ['direction of travel', '行进方向', '口头问方向可说 Which way was it moving?', 'direction of travel'],
      footage: ['review surveillance footage', '查看监控影像', 'footage 通常作不可数名词。来电人拍摄的可写 the caller’s video。', ['footage', 'review']],
      operator: ['identify the operator', '确认操作者身份', 'We have yet to identify the operator.', 'operator'],
    },
    exercise: {
      cue: '来电人称在宿舍楼附近看到无人机，似乎朝停车场方向飞，通话时已看不到。用两句英文交班。',
      answer: 'A caller reported seeing a drone near the residence hall and said it appeared to be moving toward the parking lot. The caller could no longer see it when they called.',
      check: '写明目击是谁报告的，用 appeared to 保留方向的不确定性，再交代通话时已看不到。',
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
      'The caller gave us a number so the duty officer could [[follow up with|follow-up]] her. At the time of handover, the student’s [[current whereabouts|whereabouts]] were unknown. The incident log attributed the reported times and locations to the caller.',
    ],
    translation: [
      '晚上 8:15，一名学生来电称联系不上一位朋友。她说最后一次见到他是在下午 5:30，地点在图书馆附近。大约一小时后，她收到过他发来的消息，此后再未收到消息。我们分开记录了最后见面的时间与最后收到消息的时间。',
      '来电人留下了号码，方便值班人员后续联系她。交班时，尚不清楚该学生目前在哪里。事件记录注明，相关时间和地点均由来电人提供。',
    ],
    expressions: {
      reach: ['be unable to reach someone', '暂时联系不上某人', 'The caller said they had been unable to reach the student.', 'reach'],
      'last seen': ['when and where someone was last seen', '最后一次见到某人的时间和地点', 'When and where did you last see them?', 'last seen'],
      'hear from': ['last hear from someone', '最后一次收到某人的消息', 'When did you last hear from them?', 'hear from'],
      'follow-up': ['follow up with the caller', '回访来电人', '动词用 follow up with the caller，作定语可写 follow-up questions。', ['follow-up', 'follow up']],
      whereabouts: ['current whereabouts', '目前的下落', 'Their current whereabouts are unknown. 尚在查明时可用 try to establish someone’s whereabouts。', 'whereabouts'],
    },
    exercise: {
      cue: '来电人 17:30 在食堂见过对方，19:00 收到对方的短信，此后没有消息。用两句英文交班，分清见面和联系。',
      answer: 'The caller said they last saw the student in the cafeteria at 5:30 p.m. The caller said their last contact was a text from the student at 7 p.m.',
      check: '分别写出最后见面的时间与地点，以及最后收到消息的时间与渠道。两项信息都注明来自来电人。',
    },
  },
  {
    id: 'medical-transport',
    title: '医疗转运',
    subtitle: '接人地点、出发、到院交接',
    keywords: '医疗转运 就医 送医 救护车 接人 出发 到院 交接 medical transport ambulance patient transfer pickup pick-up hospital handover',
    intake: [
      ['确认接人地点', 'Where should the transport team meet you?'],
      ['确认接收医院', 'Which hospital is expecting the patient?'],
      ['确认转运是否安排妥当', 'Has transport been arranged yet?'],
    ],
    handover: [
      ['患者已离校，尚未确认到院', 'The patient has left campus. Arrival has not yet been confirmed.'],
      ['接收团队已接手患者照护', 'The receiving team has taken over the patient’s care.'],
    ],
    report: [
      'At 2:10 p.m., the campus clinic asked us to [[arrange transport|medical transport]] to a hospital for a student. The clinic gave us the [[pickup location]] and the name of the [[receiving hospital]]. At 2:25 p.m., the transport team reported that the patient had left campus. We [[recorded the departure time|departure time]]. We had yet to [[confirm whether|confirm arrival]] the patient had arrived.',
      'At 2:45 p.m., the transport team confirmed the patient’s arrival and reported that the receiving team had [[taken over the patient’s care|transfer of care]]. We logged the time of that update. The duty officer would [[follow up with]] the clinic if any details needed clarification.',
    ],
    translation: [
      '下午 2:10，校医务室请我们安排一名学生转运到医院，并告知接人地点和接收医院名称。下午 2:25，转运团队报告患者已离校。我们记录了出发时间，当时尚未确认患者是否到院。',
      '下午 2:45，转运团队确认患者已到院，并报告接收团队已接手患者照护。我们记录了收到这条更新的时间。如果有细节需要核实，值班人员会向医务室跟进。',
    ],
    expressions: {
      'medical transport': ['arrange transport', '安排转运', '接报时可询问 Has transport been arranged yet?', ['arrange transport', 'medical transport', 'arrange']],
      'pickup location': ['pickup location', '接人地点', '接人地点用 pickup location，送达地点用 destination。', 'pickup location'],
      'receiving hospital': ['receiving hospital', '接收医院', '如果接收方并非医院，可用更宽泛的 receiving facility。', 'receiving hospital'],
      'departure time': ['record the departure time', '记录出发时间', '出发时间用 departure time，到达时间用 arrival time。', 'departure'],
      'confirm arrival': ['confirm whether the patient has arrived', '确认患者是否已到达', '尚待确认时可说 Arrival has not yet been confirmed.', ['confirm whether', 'confirm', 'arrival']],
      'transfer of care': ['take over the patient’s care', '接手患者照护', '交班时分别记录到院和接收团队接手照护的状态。', 'transfer of care'],
      'follow up with': ['follow up with the clinic', '向医务室跟进', 'follow up with 后接联系对象，follow up on 后接待跟进的事项。', ['follow up with', 'follow up']],
    },
    exercise: {
      cue: '转运团队确认车辆 13:20 已到宿舍接人。目的医院已确认，但团队说还没出发。用两句英文交班。',
      answer: 'The transport team confirmed that the vehicle reached the residence hall at 1:20 p.m. The receiving hospital has been confirmed, and the team said they had yet to leave with the patient.',
      check: '区分车到接人点、目的医院已确认和患者尚未出发这三个状态。',
    },
  },
  {
    id: 'personal-dispute',
    title: '个人纠纷',
    subtitle: '口头争执、双方陈述、目击信息',
    keywords: '个人纠纷 人际纠纷 室友 邻里 口角 争执 投诉 证人 personal dispute interpersonal dispute verbal dispute verbal altercation argument witness statement complaint',
    intake: [
      ['确认事情在哪里发生', 'Where did the disagreement happen?'],
      ['确认对方是否仍在现场', 'Is the other person still there?'],
      ['询问是否有人看到或听到', 'Did anyone else see or hear what happened?'],
    ],
    handover: [
      ['双方说法有出入', 'The two residents gave different accounts of what happened.'],
      ['通话时未收到伤情报告', 'No injuries were reported during the call.'],
      ['已听取双方说法，争执起因待核实', 'We have heard from both sides. We have yet to confirm how the dispute started.'],
    ],
    report: [
      'At 7:20 p.m., a resident reported a [[verbal dispute]] in a shared kitchen. The resident said the other person had insulted them. The second resident [[gave a different account|different account]] and said they had only asked the first resident to lower their voice. A third resident said they had heard raised voices but had not seen how the disagreement began.',
      'We [[took a statement from|statement]] each resident separately and recorded what the [[potential witness|witness]] said they had heard. No injuries were reported during the call. One resident asked how to [[lodge a complaint]]. We logged the question and agreed to [[follow up with]] the resident.',
    ],
    translation: [
      '晚上 7:20，一名宿舍住户报告公共厨房发生口头争执，称对方出言侮辱。另一名住户说法不同，称自己只是请对方放低音量。第三名住户说听到有人提高了嗓门，但没看到争执是怎么开始的。',
      '我们分别记录了两人的陈述，也记下了第三名住户自述听到的内容。通话期间未收到伤情报告。一名住户询问如何提出投诉。我们记下了这个问题，并约定向这名住户跟进。',
    ],
    expressions: {
      'verbal dispute': ['report a verbal dispute', '报告口头争执', '如果只知道双方在争执，可以先用 disagreement。', ['verbal dispute', 'dispute']],
      'different account': ['give a different account', '说法不同', '用 One person said ... The other said ... 分别交代两种说法。', 'give a different account'],
      statement: ['take a statement from someone', '记录某人的陈述', '陈述者可说 give a statement to someone。', 'statement'],
      witness: ['potential witness', '可能提供证言的人', '可继续写清对方亲眼看到、亲耳听到，或只是听别人转述。', 'witness'],
      'lodge a complaint': ['lodge a complaint', '正式提出投诉', '也可说 file a complaint。询问投诉办法时可说 asked how to lodge a complaint。', ['lodge a complaint', 'lodge', 'file a complaint']],
      'follow up with': ['follow up with the resident', '向住户跟进', '有进展后联系对方可说 get back to the resident。', ['follow up with', 'follow up']],
    },
    exercise: {
      cue: '一名室友称对方在走廊骂人，对方称只是要求安静。邻居称听到声音，但没听清说了什么。用英文写两句中立交班。',
      answer: 'One roommate said the other had insulted them in the hallway, while the other said they had only asked for quiet. A neighbor said they heard voices but could not make out what was said.',
      check: '把双方陈述分别归到各自名下，并把邻居听到声音和听清内容区分开。',
    },
  },
]
