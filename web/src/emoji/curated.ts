/**
 * Hand-picked emoji with Slack/GitHub-style shortcodes and search keywords, in picker order.
 * Format per line:  <emoji> <code>[,<alias>...] [| keyword keyword ...]
 * Lines starting with "#" start a picker category. Everything else Unicode offers is in extra.ts.
 */
export const CURATED = `
# Smileys
😀 grinning | smile happy
😃 smiley | happy joy haha
😄 smile | happy joy laugh
😁 grin | happy smile
😆 laughing,satisfied | laugh happy haha lol
😅 sweat_smile | hot happy laugh relief
🤣 rofl,rolling_on_the_floor_laughing | laugh lol lmao
😂 joy | laugh tears lol haha
🙂 slightly_smiling_face | smile
🙃 upside_down_face | silly sarcasm
🫠 melting_face | hot embarrassed
😉 wink | flirt
😊 blush | smile happy proud
😇 innocent | angel halo
🥰 smiling_face_with_three_hearts | love crush
😍 heart_eyes | love crush
🤩 star_struck | wow amazing
😘 kissing_heart | kiss love
😗 kissing | kiss
☺️ relaxed | smile
😚 kissing_closed_eyes | kiss
😙 kissing_smiling_eyes | kiss
🥲 smiling_face_with_tear | grateful touched
😋 yum | tasty delicious
😛 stuck_out_tongue | tongue silly
😜 stuck_out_tongue_winking_eye | prank silly
🤪 zany_face | crazy goofy
😝 stuck_out_tongue_closed_eyes | prank
🤑 money_mouth_face | rich money
🤗 hugs,hugging | hug
🤭 hand_over_mouth | oops giggle
🫢 face_with_open_eyes_and_hand_over_mouth | shock gasp
🫣 face_with_peeking_eye | peek scared
🤫 shushing_face | quiet shh secret
🤔 thinking | hmm think
🫡 saluting_face | salute respect
🤐 zipper_mouth_face | silence secret
🤨 raised_eyebrow | suspicious skeptic
😐 neutral_face | meh
😑 expressionless | blank
😶 no_mouth | mute silence
🫥 dotted_line_face | invisible
😏 smirk | smug
😒 unamused | meh annoyed
🙄 roll_eyes | eyeroll whatever
😬 grimacing | awkward eek
😮‍💨 face_exhaling | sigh relief
🤥 lying_face | liar pinocchio
😌 relieved | calm
😔 pensive | sad
😪 sleepy | tired
🤤 drooling_face | drool
😴 sleeping | zzz tired
😷 mask | sick ill
🤒 face_with_thermometer | sick ill fever
🤕 face_with_head_bandage | hurt
🤢 nauseated_face | sick gross
🤮 vomiting_face | puke sick
🤧 sneezing_face | sick achoo
🥵 hot_face | heat sweating
🥶 cold_face | freezing
🥴 woozy_face | drunk dizzy
😵 dizzy_face | dizzy
😵‍💫 face_with_spiral_eyes | dizzy confused
🤯 exploding_head | mind_blown shocked
🤠 cowboy_hat_face | cowboy
🥳 partying_face | party celebrate birthday
🥸 disguised_face | incognito
😎 sunglasses | cool
🤓 nerd_face | geek
🧐 monocle_face | inspect
😕 confused | huh
🫤 face_with_diagonal_mouth | meh
😟 worried | nervous
🙁 slightly_frowning_face | sad
☹️ frowning_face | sad
😮 open_mouth | surprise wow
😯 hushed | surprise
😲 astonished | shocked amazed
😳 flushed | embarrassed
🥺 pleading_face | puppy please
🥹 face_holding_back_tears | touched grateful
😦 frowning | shock
😧 anguished | shock
😨 fearful | scared
😰 cold_sweat | nervous
😥 disappointed_relieved | phew
😢 cry | sad tear
😭 sob | cry sad tears
😱 scream | horror shocked
😖 confounded | upset
😣 persevere | struggle
😞 disappointed | sad
😓 sweat | stress
😩 weary | tired
😫 tired_face | upset
🥱 yawning_face | bored tired
😤 triumph | proud angry huff
😡 rage,pout | angry mad
😠 angry | mad annoyed
🤬 cursing_face | swearing angry
😈 smiling_imp | devil evil
👿 imp | devil angry
💀 skull | dead dying lol
☠️ skull_and_crossbones | danger poison
💩 poop,hankey | shit
🤡 clown_face | clown
👹 japanese_ogre | monster
👻 ghost | halloween boo
👽 alien | ufo
🤖 robot | bot
😺 smiley_cat | cat
😸 smile_cat | cat
😹 joy_cat | cat laugh
😻 heart_eyes_cat | cat love
🙈 see_no_evil | monkey oops
🙉 hear_no_evil | monkey
🙊 speak_no_evil | monkey
# Hearts
❤️ heart,red_heart | love like
🧡 orange_heart | love
💛 yellow_heart | love
💚 green_heart | love
💙 blue_heart | love
🩵 light_blue_heart | love
💜 purple_heart | love
🤎 brown_heart | love
🖤 black_heart | love
🩶 grey_heart | love
🤍 white_heart | love
🩷 pink_heart | love
💔 broken_heart | sad heartbreak
❤️‍🔥 heart_on_fire | passion love
❤️‍🩹 mending_heart | healing
💕 two_hearts | love
💞 revolving_hearts | love
💓 heartbeat | love
💗 heartpulse | love
💖 sparkling_heart | love
💘 cupid | love
💝 gift_heart | love
💌 love_letter | love
💯 100 | hundred perfect score
💢 anger | angry
💥 boom,collision | explosion
💫 dizzy | star
💦 sweat_drops | water
💨 dash | fast wind
💬 speech_balloon | chat comment
💭 thought_balloon | think
💤 zzz | sleep
# Hands
👋 wave | hello hi bye hoi doei
🤚 raised_back_of_hand | hand
✋ hand,raised_hand | stop highfive
🖖 vulcan_salute | spock
👌 ok_hand | ok perfect
🤌 pinched_fingers | italian
🤏 pinching_hand | small tiny
✌️ v | victory peace
🤞 crossed_fingers | luck hope
🫰 hand_with_index_finger_and_thumb_crossed | money love
🤟 love_you_gesture | love
🤘 metal | rock horns
🤙 call_me_hand | call shaka
👈 point_left | left
👉 point_right | right
👆 point_up_2 | up
👇 point_down | down
☝️ point_up | up
🫵 point_at_viewer | you
👍 +1,thumbsup | like yes approve ok good
👎 -1,thumbsdown | dislike no bad
✊ fist_raised,fist | power
👊 fist_oncoming,punch | fistbump
🤛 fist_left | fistbump
🤜 fist_right | fistbump
👏 clap | applause bravo
🙌 raised_hands | hooray celebrate
🫶 heart_hands | love
👐 open_hands | hug
🤲 palms_up_together | pray
🤝 handshake | deal agreement
🙏 pray | please thanks hope
✍️ writing_hand | write
💅 nail_care | manicure sassy
🤳 selfie | phone
💪 muscle | strong flex
🧠 brain | smart
👀 eyes | look see watch
👁️ eye | look
👅 tongue | taste
👄 lips | kiss mouth
# People
👶 baby | child
🧒 child | kid
👦 boy | kid
👧 girl | kid
🧑 adult,person | human
👨 man | guy
👩 woman | lady
🧓 older_adult | old
👴 older_man | grandpa old
👵 older_woman | grandma old
🙋 raising_hand | question hi
🙋‍♂️ raising_hand_man | question hi
🙋‍♀️ raising_hand_woman | question hi
🤦 facepalm | ugh
🤦‍♂️ man_facepalming | facepalm ugh
🤦‍♀️ woman_facepalming | facepalm ugh
🤷 shrug | idk whatever
🤷‍♂️ man_shrugging | shrug idk
🤷‍♀️ woman_shrugging | shrug idk
🙇 bow | sorry thanks
💁 tipping_hand_person | information sassy
🙅 no_good | no stop
🙆 ok_person | ok
👨‍💻 technologist,man_technologist | developer coder computer
👩‍💻 woman_technologist | developer coder computer
🧑‍🍳 cook | chef
👮 police_officer,cop | police
🕵️ detective | spy
💂 guard | guard
👷 construction_worker | builder
🤴 prince | royal
👸 princess | royal
🦸 superhero | hero
🧙 mage | wizard
🧛 vampire | dracula
🧟 zombie | undead
🎅 santa | christmas sinterklaas
🏃 runner,running | run
🚶 walking | walk
💃 dancer | dance
🕺 man_dancing | dance disco
👯 dancers | party
🧘 lotus_position | yoga meditate
🛌 sleeping_bed | sleep
👫 couple | dating
💏 couplekiss | kiss
💑 couple_with_heart | love
👪 family | family
🗣️ speaking_head | talk speak
👤 bust_in_silhouette | user
👥 busts_in_silhouette | users group
# Animals & nature
🐶 dog | puppy pet
🐱 cat | kitten pet
🐭 mouse | animal
🐹 hamster | pet
🐰 rabbit | bunny
🦊 fox_face | fox
🐻 bear | animal
🐼 panda_face | panda
🐨 koala | animal
🐯 tiger | animal
🦁 lion | animal
🐮 cow | animal
🐷 pig | animal
🐸 frog | animal
🐵 monkey_face | monkey
🐒 monkey | animal
🐔 chicken | animal
🐧 penguin | animal
🐦 bird | animal
🐤 baby_chick | chick
🦆 duck | animal
🦅 eagle | bird
🦉 owl | bird
🦇 bat | animal
🐺 wolf | animal
🐗 boar | animal
🐴 horse | animal
🦄 unicorn | magic
🐝 bee,honeybee | insect
🐛 bug | insect
🦋 butterfly | insect
🐌 snail | slow
🐞 lady_beetle | ladybug
🐜 ant | insect
🕷️ spider | insect
🐢 turtle | slow
🐍 snake | animal
🦖 t-rex | dinosaur
🐙 octopus | animal
🦑 squid | animal
🦀 crab | animal
🐠 tropical_fish | fish
🐟 fish | animal
🐬 dolphin | animal
🐳 whale | animal
🦈 shark | animal
🐊 crocodile | animal
🐘 elephant | animal
🦒 giraffe | animal
🐪 camel | animal
🐑 sheep | animal
🐐 goat | animal
🐓 rooster | animal
🦃 turkey | animal
🕊️ dove | peace bird
🐿️ chipmunk | squirrel
🦔 hedgehog | animal
🐾 feet,paw_prints | paws
💐 bouquet | flowers
🌸 cherry_blossom | flower spring
🌹 rose | flower love
🌺 hibiscus | flower
🌻 sunflower | flower
🌷 tulip | flower netherlands
🌱 seedling | plant grow
🪴 potted_plant | plant
🌲 evergreen_tree | tree
🌳 deciduous_tree | tree
🌴 palm_tree | vacation beach tree
🌵 cactus | plant
🍀 four_leaf_clover | luck
🍁 maple_leaf | fall autumn
🍂 fallen_leaf | autumn
🍄 mushroom | fungi
🌍 earth_africa | globe world
🌎 earth_americas | globe world
🌏 earth_asia | globe world
🌙 crescent_moon | night
🌕 full_moon | moon
⭐ star | favourite
🌟 star2 | glow
✨ sparkles | shiny magic
⚡ zap | lightning power
🔥 fire | lit hot flame
🌈 rainbow | pride
☀️ sunny | sun weather
🌤️ sun_behind_small_cloud | weather
⛅ partly_sunny | weather
☁️ cloud | weather
🌧️ cloud_with_rain | rain weather
⛈️ cloud_with_lightning_and_rain | storm weather
❄️ snowflake | cold winter
☃️ snowman_with_snow | winter
⛄ snowman | winter
🌊 ocean | wave sea water
💧 droplet | water
☔ umbrella | rain
# Food & drink
🍏 green_apple | fruit
🍎 apple | fruit
🍐 pear | fruit
🍊 tangerine,orange | fruit
🍋 lemon | fruit
🍌 banana | fruit
🍉 watermelon | fruit
🍇 grapes | fruit
🍓 strawberry | fruit
🫐 blueberries | fruit
🍒 cherries | fruit
🍑 peach | fruit
🥭 mango | fruit
🍍 pineapple | fruit
🥥 coconut | fruit
🥝 kiwi_fruit | fruit
🍅 tomato | vegetable
🥑 avocado | fruit
🍆 eggplant | vegetable
🥔 potato | vegetable
🥕 carrot | vegetable
🌽 corn | vegetable
🌶️ hot_pepper | spicy
🥒 cucumber | vegetable
🥦 broccoli | vegetable
🧄 garlic | vegetable
🧅 onion | vegetable
🥐 croissant | breakfast
🍞 bread | toast
🥖 baguette_bread | bread
🧀 cheese | kaas
🥚 egg | breakfast
🍳 fried_egg | cooking breakfast
🥞 pancakes | breakfast
🥓 bacon | breakfast
🍗 poultry_leg | chicken
🍖 meat_on_bone | meat
🌭 hotdog | food
🍔 hamburger | burger
🍟 fries | patat
🍕 pizza | food
🥪 sandwich | food
🌮 taco | food
🌯 burrito | food
🥗 green_salad | salad
🍝 spaghetti | pasta
🍜 ramen | noodles
🍲 stew | soup
🍛 curry | food
🍣 sushi | food
🍤 fried_shrimp | food
🍚 rice | food
🥟 dumpling | food
🍦 icecream | dessert
🍨 ice_cream | dessert
🍩 doughnut | donut
🍪 cookie | dessert
🎂 birthday | cake
🍰 cake | dessert
🧁 cupcake | dessert
🍫 chocolate_bar | chocolate
🍬 candy | sweet
🍭 lollipop | sweet
🍯 honey_pot | honey
🍿 popcorn | movie
🥜 peanuts | nuts
☕ coffee | tea cafe koffie
🍵 tea | drink
🧃 beverage_box | juice
🥤 cup_with_straw | soda
🧋 bubble_tea | drink
🍺 beer | drink bier
🍻 beers | cheers proost
🥂 clinking_glasses | cheers toast champagne proost
🍷 wine_glass | wine
🥃 tumbler_glass | whisky
🍸 cocktail | drink
🍹 tropical_drink | cocktail
🍾 champagne | celebrate
🧊 ice_cube | cold
🍴 fork_and_knife | eat
🍽️ plate_with_cutlery | dinner
# Activities
⚽ soccer | football voetbal
🏀 basketball | sport
🏈 football | sport
⚾ baseball | sport
🎾 tennis | sport
🏐 volleyball | sport
🏉 rugby_football | sport
🎱 8ball | pool billiards
🏓 ping_pong | sport
🏸 badminton | sport
🏒 ice_hockey | sport
🏑 field_hockey | sport
⛳ golf | sport
🎣 fishing_pole_and_fish | fishing
🥊 boxing_glove | sport
⛸️ ice_skate | schaatsen
🎿 ski | winter
🏂 snowboarder | winter
🏋️ weight_lifting | gym
🚴 biking,bicyclist | cycling fietsen
🏊 swimmer | swim
🏆 trophy | win award
🥇 1st_place_medal | gold first
🥈 2nd_place_medal | silver
🥉 3rd_place_medal | bronze
🏅 medal_sports | medal
🎫 ticket | event
🎭 performing_arts | theater
🎨 art | paint
🎬 clapper | movie film
🎤 microphone | sing karaoke
🎧 headphones | music
🎹 musical_keyboard | piano
🥁 drum | music
🎷 saxophone | music
🎺 trumpet | music
🎸 guitar | music
🎻 violin | music
🎲 game_die | dice
♟️ chess_pawn | chess
🎯 dart | bullseye target
🎳 bowling | sport
🎮 video_game | gaming controller
🕹️ joystick | gaming
🧩 jigsaw | puzzle
🎉 tada | party celebrate congrats hooray
🎊 confetti_ball | party
🎈 balloon | party birthday
🎁 gift | present birthday
🎀 ribbon | gift
🎄 christmas_tree | christmas
🎃 jack_o_lantern | halloween pumpkin
🎆 fireworks | new_year
🎇 sparkler | fireworks
🧨 firecracker | fireworks
# Travel & places
🚗 car,red_car | drive
🚕 taxi | car
🚌 bus | transport
🚓 police_car | police
🚑 ambulance | emergency
🚒 fire_engine | fire
🚚 truck | delivery
🚜 tractor | farm
🏎️ racing_car | race
🏍️ motorcycle | bike
🛵 motor_scooter | scooter
🚲 bike | bicycle fiets
🛴 kick_scooter | scooter
🚆 train2 | train
🚇 metro | subway
🚊 tram | transport
✈️ airplane | plane flight travel
🛫 flight_departure | travel
🛬 flight_arrival | travel
🚀 rocket | launch ship
🛸 flying_saucer | ufo
🚁 helicopter | fly
⛵ boat,sailboat | sail
🚢 ship | boat
⚓ anchor | ship
⛽ fuelpump | gas
🚧 construction | wip
🗺️ world_map | map
🏠 house | home
🏡 house_with_garden | home
🏢 office | work
🏥 hospital | doctor
🏦 bank | money
🏨 hotel | travel
🏫 school | study
🏰 european_castle | castle
⛪ church | building
⛺ tent | camping
🏖️ beach_umbrella | beach vacation
🏝️ desert_island | island vacation
⛰️ mountain | nature
🌋 volcano | nature
🌅 sunrise | morning
🌇 city_sunset | evening
🌃 night_with_stars | night
🎡 ferris_wheel | fair
🎢 roller_coaster | fair
🧳 luggage | travel
# Objects
⌚ watch | time
📱 iphone,mobile_phone | phone
💻 computer,laptop | pc
⌨️ keyboard | type
🖥️ desktop_computer | pc
🖨️ printer | print
🖱️ computer_mouse | mouse
💾 floppy_disk | save
💿 cd | disc
📷 camera | photo
📸 camera_flash | photo
📹 video_camera | video
🎥 movie_camera | film
📺 tv | television
📻 radio | music
🎙️ studio_microphone | podcast
⏰ alarm_clock | time wake
⏳ hourglass_flowing_sand | wait
⌛ hourglass | time
📡 satellite | antenna
🔋 battery | power
🔌 electric_plug | power
💡 bulb | idea light
🔦 flashlight | light
🕯️ candle | light
💸 money_with_wings | money
💵 dollar | money
💶 euro | money
💰 moneybag | money rich
💳 credit_card | payment
💎 gem | diamond
⚖️ balance_scale | justice
🔧 wrench | tool fix
🔨 hammer | tool
🛠️ hammer_and_wrench | tools
⚙️ gear | settings
🧰 toolbox | tools
🧲 magnet | attract
💣 bomb | boom
🔪 hocho,knife | cut
🛡️ shield | protect
🔮 crystal_ball | fortune magic
🔭 telescope | space
🔬 microscope | science
🩺 stethoscope | doctor
💊 pill | medicine
💉 syringe | vaccine
🩹 adhesive_bandage | hurt
🧬 dna | science
🦠 microbe | virus
🧪 test_tube | science
🌡️ thermometer | temperature
🧹 broom | clean
🧻 roll_of_paper | toilet_paper
🚽 toilet | wc
🚿 shower | wash
🛁 bathtub | bath
🧼 soap | wash
🔑 key | lock
🗝️ old_key | lock
🚪 door | exit
🛋️ couch_and_lamp | sofa
🛏️ bed | sleep
🧸 teddy_bear | toy
🖼️ framed_picture | art
🛍️ shopping | bags
🛒 shopping_cart | groceries
🎒 school_satchel | backpack
👓 eyeglasses | glasses
🕶️ dark_sunglasses | cool
👔 necktie | work
👕 shirt,tshirt | clothes
👖 jeans | clothes
👗 dress | clothes
👟 athletic_shoe | sneaker
👑 crown | king queen
🧢 billed_cap | cap
💍 ring | engaged wedding
💼 briefcase | work
✉️ email,envelope | mail
📦 package | box parcel
📝 memo,pencil | note write
✏️ pencil2 | write
🖊️ pen | write
📁 file_folder | folder
📅 date | calendar
📆 calendar | date
📈 chart_with_upwards_trend | graph up stonks
📉 chart_with_downwards_trend | graph down
📊 bar_chart | stats
📋 clipboard | list
📌 pushpin | pin
📍 round_pushpin | location
📎 paperclip | attachment
✂️ scissors | cut
🗑️ wastebasket | trash delete
🔒 lock | secure
🔓 unlock | open
🔐 closed_lock_with_key | secure
🔔 bell | notification
🔕 no_bell | mute
📢 loudspeaker | announcement
📣 mega | megaphone
📖 book,open_book | read
📚 books | library study
🔖 bookmark | save
🏷️ label | tag
🔗 link | url
🧾 receipt | bill
📰 newspaper | news
🔍 mag | search
🔎 mag_right | search
🧭 compass | direction
# Symbols
✅ white_check_mark | done yes check
☑️ ballot_box_with_check | check
✔️ heavy_check_mark | check
❌ x | no cross wrong
❎ negative_squared_cross_mark | no
➕ heavy_plus_sign | plus add
➖ heavy_minus_sign | minus
✖️ heavy_multiplication_x | times
❓ question | what
❔ grey_question | what
❗ exclamation,heavy_exclamation_mark | important
❕ grey_exclamation | important
‼️ bangbang | important
⁉️ interrobang | what
⚠️ warning | caution
🚫 no_entry_sign | forbidden
⛔ no_entry | forbidden
🔞 underage | 18
♻️ recycle | green
🆗 ok | okay
🆕 new | fresh
🆓 free | gratis
🆒 cool | nice
🆘 sos | help
ℹ️ information_source | info
🔴 red_circle | red
🟠 orange_circle | orange
🟡 yellow_circle | yellow
🟢 green_circle | green
🔵 large_blue_circle,blue_circle | blue
🟣 purple_circle | purple
⚫ black_circle | black
⚪ white_circle | white
🟥 red_square | red
🟩 green_square | green
🟦 blue_square | blue
⬛ black_large_square | black
⬜ white_large_square | white
➡️ arrow_right | right
⬅️ arrow_left | left
⬆️ arrow_up | up
⬇️ arrow_down | down
🔄 arrows_counterclockwise | refresh sync
🔁 repeat | loop
▶️ arrow_forward | play
⏸️ pause_button | pause
⏹️ stop_button | stop
🔊 loud_sound | volume
🔇 mute | silent
🎵 musical_note | music
🎶 notes | music
1️⃣ one | number 1
2️⃣ two | number 2
3️⃣ three | number 3
4️⃣ four | number 4
5️⃣ five | number 5
6️⃣ six | number 6
7️⃣ seven | number 7
8️⃣ eight | number 8
9️⃣ nine | number 9
0️⃣ zero | number 0
🔟 keycap_ten | number 10
#️⃣ hash | number
™️ tm | trademark
©️ copyright | c
®️ registered | r
🆚 vs | versus
🏁 checkered_flag | finish race
🚩 triangular_flag_on_post | red_flag
🏴 black_flag | flag
🏳️ white_flag | surrender
🏳️‍🌈 rainbow_flag | pride lgbt
🏴‍☠️ pirate_flag | pirate
`;
