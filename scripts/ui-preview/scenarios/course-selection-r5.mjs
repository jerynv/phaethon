import { SETTINGS, check, showSidebar, openSettings } from '../audit-fixtures.mjs';

// Learning panels stay mounted to preserve work. Pointer actions target only the active panel.
const shown='[data-space-pane][data-shown] [data-view-shown]';
const names=['C241 Discrete Structures','M212 Calculus II'];
const folders=names.map(name=>`courses/${name}`);
const ALL=['overview','syllabus','assignments','announcements','files','grades'];
const dateIn=days=>{const d=new Date();d.setDate(d.getDate()+days);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const grade=(i)=>({connection:'c1',courseId:String(101+i),course:names[i],folder:folders[i],updated:Date.now(),current:{percent:80+i,letter:'B'},groups:[],items:[]});
const MOCK={settings:SETTINGS,threads:{},spaces:[{id:'school',name:'School',description:'',hue:240,educationEnabled:true},{id:'work',name:'Work',description:'',hue:50,educationEnabled:true}],
 lms:{list:[{id:'c1',kind:'canvas',address:'https://example.instructure.com',signedIn:true,courses:['101','102']}],courses:names.map((name,i)=>({id:String(101+i),name,current:true,imported:true}))},
 courseAccess:{school:{'c1/101':ALL,'c1/102':ALL},work:{'c1/101':ALL,'c1/102':ALL}},
 study:{courses:names.map((course,i)=>({course,folder:folders[i]})),decks:{},quizzes:{}},
 lmsGrades:{school:[grade(0),grade(1)],work:[grade(0),grade(1)]},
 planCourses:{school:names.map((name,i)=>({name,folder:folders[i]})),work:names.map((name,i)=>({name,folder:folders[i]}))},
 upcoming:{school:[{course:names[0],folder:folders[0],title:'Today worksheet',dueIn:0,link:''},{course:names[0],folder:folders[0],title:'Next week worksheet',dueIn:10,link:''},{course:names[1],folder:folders[1],title:'Calculus worksheet',dueIn:2,link:''}]},
 exams:{school:[{id:'math-exam',course:folders[1],title:'Calculus exam',date:dateIn(14)}]},
 planState:{school:{studyDays:[0,1,2,3,4,5,6],sessionsPerDay:3,sessionMinutes:25,done:[]}}};

async function view(page,h,name){
 await showSidebar(page);await h.click(`#spaces-sidebar:not([hidden]) [data-view-tab="${name}"]`);
 await page.waitForSelector(`${shown} [data-${name==='study'?'study-hub':`${name}-view`}]`);
}
async function switchSpace(page,h,id){await showSidebar(page);await h.click(`[data-space-id="${id}"]`);await page.waitForSelector(`[data-space-pane="${id}"][data-shown]`);}

export default [{name:'course-selection-r5',sizes:[[1100,720],[640,480]],mock:MOCK,
 async run(page,h){
  await view(page,h,'study');await page.waitForSelector(`${shown} [data-open-course="${folders[0]}"]`);await h.click(`${shown} [data-open-course="${folders[0]}"]`);
  await page.waitForSelector(`${shown} [data-study-hub][data-course-context="c1/101"] [data-course-back]`);
  const studyTitle=await page.$eval(`${shown} [data-study-hub] h2`,e=>({text:e.textContent,height:e.getBoundingClientRect().height,font:getComputedStyle(e).fontSize}));
  await view(page,h,'grades');await page.waitForSelector(`${shown} [data-grades-course="101"]`);
  const gradesTitle=await page.$eval(`${shown} [data-grades-view] h2`,e=>({text:e.textContent,height:e.getBoundingClientRect().height,font:getComputedStyle(e).fontSize}));
  check(studyTitle.text===names[0]&&gradesTitle.text===names[0]&&studyTitle.height===gradesTitle.height&&studyTitle.font===gradesTitle.font,'Study → Grades retains canonical course with the same title hierarchy',JSON.stringify({studyTitle,gradesTitle}));
  check(await page.$$eval(`${shown} [data-grades-view] h2`,titles=>titles.length===1),'Grades detail has one course page heading');
  check(!!await page.$(`${shown} [data-grades-course="101"] [data-grades-refresh="c1"]`),'selected-course Refresh remains in its header');
  await h.shot('grades-course');
  await view(page,h,'plan');await page.waitForFunction(()=>document.querySelector('[data-space-pane][data-shown] [data-view-shown] [data-plan-course-filter]')?.textContent.includes('C241 Discrete Structures'));
  check(await page.$eval(`${shown} [data-plan-view]`,e=>e.dataset.courseContext)==='c1/101','Plan shares the same canonical course, translating its folder filter');
  await page.$eval(`${shown} [data-plan-exams]`,e=>{e.closest('details').open=true;});
  check(await page.$eval(`${shown} [data-plan-exams]`,e=>e.textContent.includes('No exams yet.')),'course-filtered Exams has an empty state when another course has an exam');

  const firstWeek=await page.$$eval(`${shown} [data-plan-agenda-day]`,days=>days.map(e=>e.dataset.planAgendaDay));
  await h.click(`${shown} button[aria-label="Next week"]`);
  const secondWeek=await page.$$eval(`${shown} [data-plan-agenda-day]`,days=>days.map(e=>e.dataset.planAgendaDay));
  check(secondWeek[0]>firstWeek[6],'week navigation advances the complete date window');
  check(await page.$eval(`${shown} [data-plan-today]`,e=>e.dataset.planToday)===secondWeek[0],'daily agenda follows the selected week instead of stale Today');
  const dates=await page.$$eval(`${shown} [data-plan-date]`,days=>days.map(e=>e.dataset.planDate));
  check(dates.length>0&&dates.every(date=>date>=secondWeek[0]&&date<=secondWeek[6]),'Schedule contains only sessions in the selected week',JSON.stringify(dates));
  check(!await page.$(`${shown} [data-plan-today] [data-plan-focus]`),'future dates do not present a focus action as today');
  await h.click(`${shown} [data-plan-agenda-day="${secondWeek[3]}"]`);
  check(await page.$eval(`${shown} [data-plan-today]`,e=>e.dataset.planToday)===secondWeek[3],'picking an agenda day updates its session heading and contents');
  await h.shot('next-week');

  await switchSpace(page,h,'work');await view(page,h,'grades');await page.waitForSelector(`${shown} [data-course-grid]`);
  check(!await page.$(`${shown} [data-grades-course]`),'another space starts in its own course overview');
  await h.click(`${shown} [data-open-course="c1:102"]`);await page.waitForSelector(`${shown} [data-grades-course="102"]`);
  await switchSpace(page,h,'school');await view(page,h,'grades');await page.waitForSelector(`${shown} [data-grades-course="101"]`);
  check(true,'returning to School preserves C241 independently of Work’s Calculus choice');
  check(await page.$eval(`${shown} [data-course-back]`,button=>{const r=button.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&(hit===button||button.contains(hit));}),'visible Grades Courses button is the actual pointer hit target');
  await h.click(`${shown} [data-course-back]`);await page.waitForSelector(`${shown} [data-grades-view] [data-course-grid]`);
  await view(page,h,'study');await page.waitForSelector(`${shown} [data-study-hub] [data-course-grid]`);
  check(!await page.$(`${shown} [data-study-hub] [data-course-back]`),'intentional Courses back clears the context across learning views');
  await h.click(`${shown} [data-open-course="${folders[1]}"]`);await page.waitForSelector(`${shown} [data-course-back]`);await h.click(`${shown} [data-course-back]`);
  check(!!await page.$(`${shown} [data-study-hub] [data-course-grid]`),'Study Courses back also returns to the overview');
  await h.click(`${shown} [data-open-course="${folders[0]}"]`);await page.waitForSelector(`${shown} [data-course-back]`);
  await showSidebar(page);await openSettings(page,h,'courses');await page.waitForSelector('[data-course-select="c1/101"]');await h.click('[data-course-select="c1/101"]');
  await h.click('[data-access-course="c1/101"] [data-access-row="school"] [data-access-none]');
  await page.waitForFunction(()=>window.__calls.some(([command,args])=>command==='course_access_set'&&args.space==='school'&&args.course==='c1/101'&&args.parts.length===0));
  await page.keyboard.press('Escape');await page.waitForSelector(`${shown} [data-study-hub] [data-course-grid]`);
  check(!await page.$(`${shown} [data-study-hub] [data-course-back]`),'removing course access reconciles its canonical selection back to the overview');
 }}];
