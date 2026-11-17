const form = document.querySelector('form');
const argumentsInput = document.querySelector('#arguments');
const status = document.querySelector('#status');
const runButton = document.querySelector('button');

form.addEventListener('submit', async event => {
  event.preventDefault();
  runButton.disabled = true;
  status.textContent = 'Stress test running…';

  try {
    const result = await window.stressTest.run(argumentsInput.value);
    if (result.status === 'help') {
      status.textContent = result.message;
    } else {
      status.textContent = `${result.status.toUpperCase()}: ${result.passed}/${result.selected} sampled queries passed. ` +
        `Report: ${result.reportPath}`;
    }
  } catch (error) {
    status.textContent = `Unable to run stress test: ${error.message}`;
  } finally {
    runButton.disabled = false;
  }
});
